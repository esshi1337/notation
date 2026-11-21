//! MySQL: one prepared statement inside `START TRANSACTION READ ONLY`,
//! always rolled back, on a session whose transactions default to
//! read-only, with `MAX_EXECUTION_TIME` and `KILL QUERY` for cancel.
//!
//! The client library enables multi-statement text queries, so the block's
//! text is only ever sent through the prepared-statement protocol, which
//! accepts exactly one statement. The fixed session commands below are the
//! only text-protocol queries.
use super::{cell, clock, tls, Collector, Column, Job, Parameter, SqlError, TlsMode};
use mysql_async::consts::ColumnType;
use mysql_async::prelude::Queryable;
use mysql_async::{Conn, DriverError, Opts, OptsBuilder, Params, SslOpts};
use serde_json::Value;
use std::time::Duration;

fn failure(error: &mysql_async::Error) -> SqlError {
    match error {
        mysql_async::Error::Server(server) => {
            let text = format!("MySQL error {}: {}", server.code, server.message);
            match server.code {
                // ER_QUERY_TIMEOUT, ER_QUERY_INTERRUPTED (KILL QUERY).
                3024 | 1317 => SqlError::new("timeout", text),
                // ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION, ER_OPTION_PREVENTS_STATEMENT.
                1792 | 1290 => SqlError::new("refused", format!("SQL blocks are read-only. MySQL refused the statement: {}", server.message)),
                // ER_UNSUPPORTED_PS.
                1295 => SqlError::new("refused", "MySQL cannot run this kind of statement as a single prepared statement, so it cannot run in a SQL block."),
                _ => SqlError::new("query", text),
            }
        }
        other => SqlError::new("query", format!("MySQL: {other}")),
    }
}

fn not_a_query() -> SqlError {
    SqlError::new("refused", "SQL blocks are read-only. MySQL reports that this statement does not return rows, so it was not run.")
}

fn options(job: &Job<'_>, tls: bool) -> Opts {
    let profile = job.profile;
    let mut builder = OptsBuilder::default()
        .ip_or_hostname(profile.host.clone())
        .tcp_port(profile.port)
        .user(Some(profile.user.clone()))
        .pass(job.password.map(|secret| secret.expose().to_string()))
        .db_name((!profile.database.is_empty()).then(|| profile.database.clone()))
        // Always the configured host and port, never a local socket the
        // server advertises.
        .prefer_socket(false)
        .stmt_cache_size(0)
        .tcp_nodelay(true);
    if tls {
        let ssl = match profile.tls_mode {
            TlsMode::VerifyFull if !profile.ca_file.is_empty() => SslOpts::default()
                .with_root_certs(vec![std::path::PathBuf::from(&profile.ca_file).into()])
                .with_disable_built_in_roots(true),
            TlsMode::VerifyFull => SslOpts::default(),
            // Encrypt without authenticating the server.
            _ => SslOpts::default().with_danger_accept_invalid_certs(true),
        };
        builder = builder.ssl_opts(ssl);
    }
    builder.into()
}

async fn connect(job: &Job<'_>) -> Result<Conn, mysql_async::Error> {
    tls::install_default_provider();
    match job.profile.tls_mode {
        TlsMode::Disable => Conn::new(options(job, false)).await,
        TlsMode::Prefer => match Conn::new(options(job, true)).await {
            // Only when the server has no TLS at all; a failed handshake or
            // a wrong password is reported, not retried in the clear.
            Err(mysql_async::Error::Driver(DriverError::NoClientSslFlagFromServer)) => {
                Conn::new(options(job, false)).await
            }
            other => other,
        },
        TlsMode::Require | TlsMode::VerifyFull => Conn::new(options(job, true)).await,
    }
}

fn decode(value: mysql_async::Value, column: &mysql_async::Column) -> Value {
    use mysql_async::Value as Sql;
    let kind = column.column_type();
    match value {
        Sql::NULL => Value::Null,
        Sql::Int(value) => cell::integer(value),
        Sql::UInt(value) => i64::try_from(value)
            .map_or_else(|_| cell::tagged("number", value.to_string()), cell::integer),
        // Through text, so 0.1 reads 0.1 and not 0.10000000149.
        Sql::Float(value) => {
            cell::float(value.to_string().parse::<f64>().unwrap_or(f64::from(value)))
        }
        Sql::Double(value) => cell::float(value),
        Sql::Date(year, month, day, hour, minute, second, micros) => {
            if matches!(
                kind,
                ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE
            ) {
                cell::tagged("date", format!("{year:04}-{month:02}-{day:02}"))
            } else {
                cell::tagged(
                    "datetime",
                    format!(
                        "{year:04}-{month:02}-{day:02} {}",
                        clock(
                            i64::from(hour),
                            u32::from(minute),
                            u32::from(second),
                            micros
                        )
                    ),
                )
            }
        }
        Sql::Time(negative, days, hours, minutes, seconds, micros) => cell::tagged(
            "time",
            format!(
                "{}{}",
                if negative { "-" } else { "" },
                clock(
                    i64::from(days) * 24 + i64::from(hours),
                    u32::from(minutes),
                    u32::from(seconds),
                    micros
                )
            ),
        ),
        Sql::Bytes(bytes) => match kind {
            ColumnType::MYSQL_TYPE_DECIMAL | ColumnType::MYSQL_TYPE_NEWDECIMAL => {
                match std::str::from_utf8(&bytes) {
                    Ok(text) => cell::tagged("number", text),
                    Err(_) => cell::bytes(&bytes),
                }
            }
            ColumnType::MYSQL_TYPE_JSON => match std::str::from_utf8(&bytes) {
                Ok(text) => cell::tagged_text("json", text),
                Err(_) => cell::bytes(&bytes),
            },
            ColumnType::MYSQL_TYPE_BIT | ColumnType::MYSQL_TYPE_GEOMETRY => cell::bytes(&bytes),
            // Character set 63 is `binary`: BLOB, BINARY, VARBINARY.
            _ if column.character_set() == 63 => cell::bytes(&bytes),
            _ => cell::text_bytes(&bytes),
        },
    }
}

fn type_name(column: &mysql_async::Column) -> String {
    format!("{:?}", column.column_type())
        .trim_start_matches("MYSQL_TYPE_")
        .to_ascii_lowercase()
}

/// Returns `true` when every row was read.
async fn query(conn: &mut Conn, job: &Job<'_>, out: &mut Collector) -> Result<bool, SqlError> {
    let fail = |error: mysql_async::Error| failure(&error);
    conn.query_drop("SET SESSION TRANSACTION READ ONLY")
        .await
        .map_err(fail)?;
    // MySQL takes milliseconds; MariaDB has a different variable, in
    // seconds. Either may be missing: the client-side timer still applies.
    if conn
        .query_drop(format!(
            "SET SESSION MAX_EXECUTION_TIME={}",
            job.timeout.as_millis()
        ))
        .await
        .is_err()
    {
        let _ = conn
            .query_drop(format!(
                "SET SESSION max_statement_time={}",
                job.timeout.as_secs()
            ))
            .await;
    }
    conn.query_drop("START TRANSACTION READ ONLY")
        .await
        .map_err(fail)?;
    let statement = conn.prep(job.sql).await.map_err(fail)?;
    // The server says, before anything runs, whether the statement returns
    // rows. One that does not (CALL, DO, SET, any write, SELECT … INTO
    // OUTFILE) is not executed: a stored procedure could otherwise commit
    // and switch its session back to read-write. SHOW, DESCRIBE and EXPLAIN
    // report their columns only when run, so they are recognised by their
    // first keyword instead.
    if statement.columns().is_empty() {
        let reports = super::guard::mysql_leading_keyword(job.sql);
        if !matches!(
            reports.as_deref(),
            Some("SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN")
        ) {
            return Err(not_a_query());
        }
    }
    let parameters = if job.parameters.is_empty() {
        Params::Empty
    } else {
        Params::Positional(
            job.parameters
                .iter()
                .map(|(_, value)| match value {
                    Parameter::Null => mysql_async::Value::NULL,
                    Parameter::Bool(value) => mysql_async::Value::Int(i64::from(*value)),
                    Parameter::Integer(value) => mysql_async::Value::Int(*value),
                    Parameter::Float(value) => mysql_async::Value::Double(*value),
                    Parameter::Text(value) => mysql_async::Value::Bytes(value.clone().into_bytes()),
                })
                .collect(),
        )
    };
    let mut result = conn.exec_iter(&statement, parameters).await.map_err(fail)?;
    let columns: Vec<mysql_async::Column> = result.columns_ref().to_vec();
    out.set_columns(
        columns
            .iter()
            .map(|column| Column {
                name: column.name_str().into_owned(),
                type_name: type_name(column),
            })
            .collect(),
    )?;
    let mut complete = true;
    while let Some(row) = result.next().await.map_err(fail)? {
        let values = row
            .unwrap()
            .into_iter()
            .zip(&columns)
            .map(|(value, column)| decode(value, column))
            .collect();
        if !out.push(values) {
            complete = false;
            break;
        }
    }
    drop(result);
    if complete {
        // Nothing is ever committed.
        conn.query_drop("ROLLBACK").await.map_err(fail)?;
    }
    Ok(complete)
}

/// Stop the statement on the server from a second connection.
async fn kill(job: &Job<'_>, id: u32) {
    let request = async {
        if let Ok(mut conn) = connect(job).await {
            let _ = conn.query_drop(format!("KILL QUERY {id}")).await;
            let _ = conn.disconnect().await;
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(5), request).await;
}

pub(crate) async fn run(job: &Job<'_>, out: &mut Collector) -> Result<(), SqlError> {
    let deadline = tokio::time::Instant::now() + job.timeout;
    let timed_out = || {
        SqlError::new(
            "timeout",
            format!(
                "The query was stopped after {} s (the connection's timeout).",
                job.timeout.as_secs()
            ),
        )
    };
    let cancelled = || SqlError::new("cancelled", "Query cancelled.");
    let mut conn = tokio::select! {
        conn = connect(job) => conn.map_err(|error| {
            let mut error = failure(&error);
            error.code = "connect";
            error
        })?,
        _ = job.cancel.cancelled() => return Err(cancelled()),
        _ = tokio::time::sleep_until(deadline) => return Err(SqlError::new("timeout", "Connecting took longer than the connection's timeout.")),
    };
    let id = conn.id();
    let outcome = tokio::select! {
        outcome = query(&mut conn, job, out) => outcome,
        _ = job.cancel.cancelled() => Err(cancelled()),
        _ = tokio::time::sleep_until(deadline + Duration::from_secs(1)) => Err(timed_out()),
    };
    match outcome {
        Ok(true) => {
            let _ = conn.disconnect().await;
            Ok(())
        }
        Ok(false) => {
            // Rows remain unread: stop the statement instead of draining
            // them, then let the connection close in the background.
            kill(job, id).await;
            drop(conn);
            Ok(())
        }
        Err(error) => {
            if matches!(error.code, "cancelled" | "timeout") {
                kill(job, id).await;
            }
            drop(conn);
            Err(if error.code == "timeout" {
                timed_out()
            } else {
                error
            })
        }
    }
}
