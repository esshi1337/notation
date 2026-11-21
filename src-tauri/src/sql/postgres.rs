//! Postgres: one prepared statement inside `START TRANSACTION READ ONLY`,
//! always rolled back, with `statement_timeout` and a server-side cancel.
use super::{
    cell, civil_from_days, clock, tls, Collector, Column, Job, Parameter, SqlError, TlsMode,
};
use serde_json::Value;
use std::error::Error;
use tokio_postgres::config::SslMode;
use tokio_postgres::types::private::BytesMut;
use tokio_postgres::types::{FromSql, IsNull, Kind as TypeKind, ToSql, Type};
use tokio_postgres::{CancelToken, Client, Config, NoTls};
use tokio_postgres_rustls::MakeRustlsConnect;

const FETCH: i32 = 256;
/// Days from 1970-01-01 to the Postgres epoch, 2000-01-01.
const EPOCH_DAYS: i64 = 10_957;
const DAY_MICROS: i64 = 86_400_000_000;

fn failure(error: &tokio_postgres::Error) -> SqlError {
    if let Some(database) = error.as_db_error() {
        let mut message = format!("{}: {}", database.severity(), database.message());
        if let Some(detail) = database.detail() {
            message.push_str(&format!(" ({detail})"));
        }
        if let Some(hint) = database.hint() {
            message.push_str(&format!(" Hint: {hint}"));
        }
        let code = database.code().code();
        if code == "57014" {
            return SqlError::new(
                "timeout",
                format!("Postgres stopped the query: {}", database.message()),
            );
        }
        if code == "25006" {
            return SqlError::new(
                "refused",
                format!(
                    "SQL blocks are read-only. Postgres refused the statement: {}",
                    database.message()
                ),
            );
        }
        return SqlError::new("query", format!("Postgres {message} [{code}]"));
    }
    // Client-side errors: add the cause ("Connection refused", a TLS alert).
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    SqlError::new(
        if error.is_closed() {
            "connect"
        } else {
            "query"
        },
        format!("Postgres: {message}"),
    )
}

/// The raw bytes of any column, so every type can be decoded here.
struct Raw<'a>(Option<&'a [u8]>);
impl<'a> FromSql<'a> for Raw<'a> {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn Error + Sync + Send>> {
        Ok(Raw(Some(raw)))
    }
    fn from_sql_null(_: &Type) -> Result<Self, Box<dyn Error + Sync + Send>> {
        Ok(Raw(None))
    }
    fn accepts(_: &Type) -> bool {
        true
    }
}

fn be<const N: usize>(raw: &[u8]) -> Option<[u8; N]> {
    raw.get(..N)?.try_into().ok()
}

/// `numeric` wire format: base-10000 digits with a weight and a scale.
pub(crate) fn numeric_text(raw: &[u8]) -> Option<String> {
    let count = u16::from_be_bytes(be(raw)?) as usize;
    let weight = i32::from(i16::from_be_bytes(be(&raw[2..])?));
    let sign = u16::from_be_bytes(be(&raw[4..])?);
    let scale = u16::from_be_bytes(be(&raw[6..])?) as usize;
    match sign {
        0xC000 => return Some("NaN".into()),
        0xD000 => return Some("Infinity".into()),
        0xF000 => return Some("-Infinity".into()),
        _ => {}
    }
    let digits: Vec<u16> = (0..count)
        .map(|index| be(raw.get(8 + 2 * index..)?).map(u16::from_be_bytes))
        .collect::<Option<_>>()?;
    let digit = |index: i32| {
        if index < 0 {
            0
        } else {
            digits.get(index as usize).copied().unwrap_or(0)
        }
    };
    let mut text = String::new();
    if sign == 0x4000 {
        text.push('-');
    }
    if weight < 0 {
        text.push('0');
    } else {
        for index in 0..=weight {
            text.push_str(&if index == 0 {
                digit(index).to_string()
            } else {
                format!("{:04}", digit(index))
            });
        }
    }
    if scale > 0 {
        let mut fraction = String::new();
        let mut index = weight + 1;
        while fraction.len() < scale {
            fraction.push_str(&format!("{:04}", digit(index)));
            index += 1;
        }
        fraction.truncate(scale);
        text.push('.');
        text.push_str(&fraction);
    }
    Some(text)
}

/// Encode decimal text (`-12.50`) as a `numeric` parameter.
pub(crate) fn numeric_bytes(text: &str) -> Option<Vec<u8>> {
    let (negative, unsigned) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    if whole.is_empty() && fraction.is_empty()
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|byte| byte.is_ascii_digit())
        || unsigned.len() > 1000
    {
        return None;
    }
    let mut padded = "0".repeat((4 - whole.len() % 4) % 4);
    padded.push_str(whole);
    let whole_groups = padded.len() / 4;
    padded.push_str(fraction);
    padded.push_str(&"0".repeat((4 - fraction.len() % 4) % 4));
    let mut digits: Vec<u16> = padded
        .as_bytes()
        .chunks(4)
        .map(|chunk| {
            chunk
                .iter()
                .fold(0u16, |value, byte| value * 10 + u16::from(byte - b'0'))
        })
        .collect();
    let mut weight = whole_groups as i16 - 1;
    while digits.first() == Some(&0) {
        digits.remove(0);
        weight -= 1;
    }
    while digits.last() == Some(&0) {
        digits.pop();
    }
    if digits.is_empty() {
        weight = 0;
    }
    let mut out = Vec::with_capacity(8 + digits.len() * 2);
    out.extend_from_slice(&(digits.len() as i16).to_be_bytes());
    out.extend_from_slice(&weight.to_be_bytes());
    out.extend_from_slice(
        &(if negative && !digits.is_empty() {
            0x4000u16
        } else {
            0
        })
        .to_be_bytes(),
    );
    out.extend_from_slice(&(fraction.len() as u16).to_be_bytes());
    for digit in digits {
        out.extend_from_slice(&digit.to_be_bytes());
    }
    Some(out)
}

fn date_text(days: i32) -> String {
    match days {
        i32::MAX => "infinity".into(),
        i32::MIN => "-infinity".into(),
        days => {
            let (year, month, day) = civil_from_days(i64::from(days) + EPOCH_DAYS);
            format!("{year:04}-{month:02}-{day:02}")
        }
    }
}
fn time_text(micros: i64) -> String {
    let seconds = micros.div_euclid(1_000_000);
    clock(
        seconds / 3600,
        (seconds / 60 % 60) as u32,
        (seconds % 60) as u32,
        micros.rem_euclid(1_000_000) as u32,
    )
}
fn timestamp_text(micros: i64) -> String {
    match micros {
        i64::MAX => "infinity".into(),
        i64::MIN => "-infinity".into(),
        micros => {
            let (year, month, day) = civil_from_days(micros.div_euclid(DAY_MICROS) + EPOCH_DAYS);
            format!(
                "{year:04}-{month:02}-{day:02} {}",
                time_text(micros.rem_euclid(DAY_MICROS))
            )
        }
    }
}
fn offset_text(seconds_east: i32) -> String {
    let sign = if seconds_east < 0 { '-' } else { '+' };
    let seconds = seconds_east.unsigned_abs();
    if seconds % 3600 == 0 {
        format!("{sign}{:02}", seconds / 3600)
    } else {
        format!("{sign}{:02}:{:02}", seconds / 3600, seconds / 60 % 60)
    }
}
fn interval_text(raw: &[u8]) -> Option<String> {
    let micros = i64::from_be_bytes(be(raw)?);
    let days = i32::from_be_bytes(be(&raw[8..])?);
    let months = i32::from_be_bytes(be(&raw[12..])?);
    let mut parts = Vec::new();
    if months / 12 != 0 {
        parts.push(format!(
            "{} year{}",
            months / 12,
            if months / 12 == 1 { "" } else { "s" }
        ));
    }
    if months % 12 != 0 {
        parts.push(format!(
            "{} mon{}",
            months % 12,
            if months % 12 == 1 { "" } else { "s" }
        ));
    }
    if days != 0 {
        parts.push(format!("{days} day{}", if days == 1 { "" } else { "s" }));
    }
    if micros != 0 || parts.is_empty() {
        let sign = if micros < 0 { "-" } else { "" };
        parts.push(format!("{sign}{}", time_text(micros.abs())));
    }
    Some(parts.join(" "))
}
fn inet_text(raw: &[u8]) -> Option<String> {
    let (family, bits, is_cidr, length) = (
        *raw.first()?,
        *raw.get(1)?,
        *raw.get(2)?,
        *raw.get(3)? as usize,
    );
    let address = raw.get(4..4 + length)?;
    let (text, full) = match (family, length) {
        (2, 4) => (std::net::Ipv4Addr::from(be::<4>(address)?).to_string(), 32),
        (3, 16) => (
            std::net::Ipv6Addr::from(be::<16>(address)?).to_string(),
            128,
        ),
        _ => return None,
    };
    Some(if is_cidr != 0 || bits != full {
        format!("{text}/{bits}")
    } else {
        text
    })
}
fn uuid_text(raw: &[u8]) -> Option<String> {
    let bytes = be::<16>(raw)?;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Some(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

/// A value this module has no decoder for.
fn opaque(ty: &Type) -> Value {
    cell::tagged("other", format!("⟨{}: cast to text to display⟩", ty.name()))
}

fn array(element: &Type, raw: &[u8]) -> Option<Value> {
    let dimensions = i32::from_be_bytes(be(raw)?);
    if !(0..=6).contains(&dimensions) {
        return None;
    }
    let mut sizes = Vec::new();
    let mut at = 12;
    for _ in 0..dimensions {
        sizes.push(usize::try_from(i32::from_be_bytes(be(raw.get(at..)?)?)).ok()?);
        at += 8;
    }
    fn build(sizes: &[usize], element: &Type, raw: &[u8], at: &mut usize) -> Option<Value> {
        let Some((&size, rest)) = sizes.split_first() else {
            return Some(Value::Array(Vec::new()));
        };
        let mut items = Vec::with_capacity(size.min(1024));
        for _ in 0..size {
            if !rest.is_empty() {
                items.push(build(rest, element, raw, at)?);
                continue;
            }
            let length = i32::from_be_bytes(be(raw.get(*at..)?)?);
            *at += 4;
            if length < 0 {
                items.push(Value::Null);
                continue;
            }
            let bytes = raw.get(*at..*at + length as usize)?;
            *at += length as usize;
            // Inside an array, special values are shown as their text.
            items.push(match decode(element, bytes) {
                Value::Object(fields) => fields.get("v").cloned().unwrap_or(Value::Null),
                plain => plain,
            });
        }
        Some(Value::Array(items))
    }
    build(&sizes, element, raw, &mut at)
}

/// One column value in the binary wire format.
fn decode(ty: &Type, raw: &[u8]) -> Value {
    match ty.kind() {
        TypeKind::Enum(_) => return cell::text_bytes(raw),
        TypeKind::Domain(inner) => return decode(inner, raw),
        TypeKind::Array(element) => {
            return array(element, raw)
                .and_then(|items| serde_json::to_string(&items).ok())
                .map_or_else(|| opaque(ty), |text| cell::tagged_text("json", &text));
        }
        _ => {}
    }
    let value = match *ty {
        Type::BOOL => raw.first().map(|byte| Value::Bool(*byte != 0)),
        Type::INT2 => be(raw).map(|bytes| cell::integer(i64::from(i16::from_be_bytes(bytes)))),
        Type::INT4 => be(raw).map(|bytes| cell::integer(i64::from(i32::from_be_bytes(bytes)))),
        Type::INT8 => be(raw).map(|bytes| cell::integer(i64::from_be_bytes(bytes))),
        Type::OID | Type::XID | Type::CID | Type::REGPROC | Type::REGCLASS | Type::REGTYPE => {
            be(raw).map(|bytes| cell::integer(i64::from(u32::from_be_bytes(bytes))))
        }
        Type::FLOAT4 => be(raw).map(|bytes| {
            // Through text, so 0.1 reads 0.1 and not 0.10000000149.
            let value = f32::from_be_bytes(bytes);
            cell::float(value.to_string().parse::<f64>().unwrap_or(f64::from(value)))
        }),
        Type::FLOAT8 => be(raw).map(|bytes| cell::float(f64::from_be_bytes(bytes))),
        Type::NUMERIC => numeric_text(raw).map(|text| cell::tagged("number", text)),
        Type::MONEY => be(raw).map(|bytes| {
            let cents = i64::from_be_bytes(bytes);
            cell::tagged(
                "number",
                format!(
                    "{}{}.{:02}",
                    if cents < 0 { "-" } else { "" },
                    cents.unsigned_abs() / 100,
                    cents.unsigned_abs() % 100
                ),
            )
        }),
        Type::TEXT
        | Type::VARCHAR
        | Type::BPCHAR
        | Type::NAME
        | Type::UNKNOWN
        | Type::XML
        | Type::CHAR => Some(cell::text_bytes(raw)),
        Type::JSON => std::str::from_utf8(raw)
            .ok()
            .map(|text| cell::tagged_text("json", text)),
        Type::JSONB => raw
            .get(1..)
            .and_then(|body| std::str::from_utf8(body).ok())
            .map(|text| cell::tagged_text("json", text)),
        Type::BYTEA => Some(cell::bytes(raw)),
        Type::UUID => uuid_text(raw).map(Value::String),
        Type::DATE => {
            be(raw).map(|bytes| cell::tagged("date", date_text(i32::from_be_bytes(bytes))))
        }
        Type::TIME => {
            be(raw).map(|bytes| cell::tagged("time", time_text(i64::from_be_bytes(bytes))))
        }
        Type::TIMETZ => be::<8>(raw)
            .zip(raw.get(8..).and_then(be::<4>))
            .map(|(time, zone)| {
                // The wire value is seconds west of UTC.
                cell::tagged(
                    "time",
                    format!(
                        "{}{}",
                        time_text(i64::from_be_bytes(time)),
                        offset_text(-i32::from_be_bytes(zone))
                    ),
                )
            }),
        Type::TIMESTAMP => {
            be(raw).map(|bytes| cell::tagged("datetime", timestamp_text(i64::from_be_bytes(bytes))))
        }
        Type::TIMESTAMPTZ => be(raw).map(|bytes| {
            let micros = i64::from_be_bytes(bytes);
            let text = timestamp_text(micros);
            cell::tagged(
                "datetime",
                if micros == i64::MAX || micros == i64::MIN {
                    text
                } else {
                    text + "+00"
                },
            )
        }),
        Type::INTERVAL => interval_text(raw).map(|text| cell::tagged("other", text)),
        Type::INET | Type::CIDR => inet_text(raw).map(Value::String),
        // Extension types whose binary form is their text.
        _ if matches!(ty.name(), "citext" | "ltree" | "lquery") => Some(cell::text_bytes(raw)),
        _ => None,
    };
    value.unwrap_or_else(|| opaque(ty))
}

/// A `:name` value, encoded for whatever type the server inferred.
#[derive(Debug)]
struct Bound<'a>(&'a str, &'a Parameter);
impl ToSql for Bound<'_> {
    fn to_sql(
        &self,
        ty: &Type,
        out: &mut BytesMut,
    ) -> Result<IsNull, Box<dyn Error + Sync + Send>> {
        let mismatch = |wanted: &str| -> Box<dyn Error + Sync + Send> {
            format!("Parameter :{} is used as {} but its value is not {wanted}. Change the property, or cast in SQL: :{}::text::{}", self.0, ty.name(), self.0, ty.name()).into()
        };
        let text = match self.1 {
            Parameter::Null => return Ok(IsNull::Yes),
            Parameter::Bool(value) => value.to_string(),
            Parameter::Integer(value) => value.to_string(),
            Parameter::Float(value) => value.to_string(),
            Parameter::Text(value) => value.clone(),
        };
        let base = match ty.kind() {
            TypeKind::Domain(inner) => inner,
            _ => ty,
        };
        match *base {
            Type::BOOL => match self.1 {
                Parameter::Bool(value) => out.extend_from_slice(&[u8::from(*value)]),
                _ => match text.to_ascii_lowercase().as_str() {
                    "true" | "t" | "yes" | "1" => out.extend_from_slice(&[1]),
                    "false" | "f" | "no" | "0" => out.extend_from_slice(&[0]),
                    _ => return Err(mismatch("true or false")),
                },
            },
            Type::INT2 => out.extend_from_slice(
                &text
                    .parse::<i16>()
                    .map_err(|_| mismatch("a small whole number"))?
                    .to_be_bytes(),
            ),
            Type::INT4 => out.extend_from_slice(
                &text
                    .parse::<i32>()
                    .map_err(|_| mismatch("a whole number"))?
                    .to_be_bytes(),
            ),
            Type::INT8 => out.extend_from_slice(
                &text
                    .parse::<i64>()
                    .map_err(|_| mismatch("a whole number"))?
                    .to_be_bytes(),
            ),
            Type::OID => out.extend_from_slice(
                &text
                    .parse::<u32>()
                    .map_err(|_| mismatch("a whole number"))?
                    .to_be_bytes(),
            ),
            Type::FLOAT4 => out.extend_from_slice(
                &text
                    .parse::<f32>()
                    .map_err(|_| mismatch("a number"))?
                    .to_be_bytes(),
            ),
            Type::FLOAT8 => out.extend_from_slice(
                &text
                    .parse::<f64>()
                    .map_err(|_| mismatch("a number"))?
                    .to_be_bytes(),
            ),
            Type::NUMERIC => {
                out.extend_from_slice(&numeric_bytes(&text).ok_or_else(|| mismatch("a number"))?)
            }
            Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN => {
                out.extend_from_slice(text.as_bytes())
            }
            _ => {
                return Err(format!(
                "Parameter :{} is used as {}. Cast it in SQL so it is sent as text: :{}::text::{}",
                self.0,
                ty.name(),
                self.0,
                ty.name()
            )
                .into())
            }
        }
        Ok(IsNull::No)
    }
    fn accepts(_: &Type) -> bool {
        true
    }
    tokio_postgres::types::to_sql_checked!();
}

async fn connect(
    job: &Job<'_>,
    tls: Option<MakeRustlsConnect>,
) -> Result<Client, tokio_postgres::Error> {
    let profile = job.profile;
    let mut config = Config::new();
    config
        .host(&profile.host)
        .port(profile.port)
        .user(&profile.user)
        .application_name("Notation read-only SQL block")
        .connect_timeout(job.timeout.min(std::time::Duration::from_secs(20)))
        .ssl_mode(match profile.tls_mode {
            TlsMode::Disable => SslMode::Disable,
            TlsMode::Prefer => SslMode::Prefer,
            TlsMode::Require | TlsMode::VerifyFull => SslMode::Require,
        });
    if !profile.database.is_empty() {
        config.dbname(&profile.database);
    }
    if let Some(password) = job.password {
        config.password(password.expose());
    }
    // The connection task ends when the client is dropped.
    match tls {
        Some(tls) => {
            let (client, connection) = config.connect(tls).await?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            Ok(client)
        }
        None => {
            let (client, connection) = config.connect(NoTls).await?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            Ok(client)
        }
    }
}

async fn query(client: &mut Client, job: &Job<'_>, out: &mut Collector) -> Result<(), SqlError> {
    let fail = |error: tokio_postgres::Error| failure(&error);
    let millis = job.timeout.as_millis();
    // Constants and numbers only. The session default is read-only too, so
    // nothing outside the transaction below could write either.
    client
        .batch_execute(&format!(
            "SET statement_timeout = {millis}; SET lock_timeout = {millis}; SET idle_in_transaction_session_timeout = {}; SET default_transaction_read_only = on",
            millis + 5000
        ))
        .await
        .map_err(fail)?;
    let transaction = client
        .build_transaction()
        .read_only(true)
        .start()
        .await
        .map_err(fail)?;
    // Take the transaction's first snapshot now. Postgres refuses to switch
    // a transaction to read-write "after any query", so nothing the block
    // runs (a DO block, a procedure) can lift the read-only mode.
    transaction.batch_execute("SELECT 1").await.map_err(fail)?;
    // The extended protocol: exactly one statement, parameters sent apart
    // from the text.
    let statement = transaction.prepare(job.sql).await.map_err(fail)?;
    // The server says, before anything runs, whether the statement returns
    // rows. One that does not (DO, CALL, SET, COPY, any plain write) is not
    // executed.
    if statement.columns().is_empty() {
        return Err(SqlError::new("refused", "SQL blocks are read-only. Postgres reports that this statement does not return rows, so it was not run."));
    }
    out.set_columns(
        statement
            .columns()
            .iter()
            .map(|column| Column {
                name: column.name().to_string(),
                type_name: column.type_().name().to_string(),
            })
            .collect(),
    )?;
    let bound: Vec<Bound<'_>> = job
        .parameters
        .iter()
        .map(|(name, value)| Bound(name, value))
        .collect();
    let references: Vec<&(dyn ToSql + Sync)> = bound
        .iter()
        .map(|value| value as &(dyn ToSql + Sync))
        .collect();
    let portal = transaction
        .bind(&statement, &references)
        .await
        .map_err(|error| {
            // A parameter that could not be encoded reports through `source`.
            match error.source() {
                Some(cause) if error.as_db_error().is_none() => {
                    SqlError::new("invalid", cause.to_string())
                }
                _ => failure(&error),
            }
        })?;
    'read: loop {
        let wanted = (out.wanted() as i32).min(FETCH);
        let rows = transaction
            .query_portal(&portal, wanted)
            .await
            .map_err(fail)?;
        let last = rows.len() < wanted as usize;
        for row in &rows {
            let mut values = Vec::with_capacity(row.len());
            for (index, column) in row.columns().iter().enumerate() {
                values.push(match row.try_get::<_, Raw<'_>>(index).map_err(fail)?.0 {
                    None => Value::Null,
                    Some(raw) => decode(column.type_(), raw),
                });
            }
            if !out.push(values) {
                break 'read;
            }
        }
        if last {
            break;
        }
    }
    // Nothing is ever committed.
    transaction.rollback().await.map_err(fail)
}

pub(crate) async fn run(job: &Job<'_>, out: &mut Collector) -> Result<(), SqlError> {
    let tls = match job.profile.tls_mode {
        TlsMode::Disable => None,
        _ => Some(MakeRustlsConnect::new(tls::client_config(job.profile)?)),
    };
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
    let mut client = tokio::select! {
        client = connect(job, tls.clone()) => client.map_err(|error| {
            let mut error = failure(&error);
            error.code = "connect";
            error
        })?,
        _ = job.cancel.cancelled() => return Err(cancelled()),
        _ = tokio::time::sleep_until(deadline) => return Err(SqlError::new("timeout", "Connecting took longer than the connection's timeout.")),
    };
    let token = client.cancel_token();
    let stop = |token: CancelToken, tls: Option<MakeRustlsConnect>| async move {
        // Ask the server to abort the statement; closing the socket alone
        // would let it run on.
        let request = async {
            match tls {
                Some(tls) => token.cancel_query(tls).await,
                None => token.cancel_query(NoTls).await,
            }
        };
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), request).await;
    };
    let outcome = tokio::select! {
        outcome = query(&mut client, job, out) => outcome,
        _ = job.cancel.cancelled() => {
            stop(token, tls).await;
            Err(cancelled())
        }
        _ = tokio::time::sleep_until(deadline + std::time::Duration::from_secs(1)) => {
            stop(token, tls).await;
            Err(timed_out())
        }
    };
    match outcome {
        Err(error) if error.code == "timeout" => Err(timed_out()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_round_trips_through_the_wire_format() {
        for text in [
            "0",
            "1",
            "-1",
            "12345.6789",
            "0.0001",
            "0.00000001",
            "-999999999999.5",
            "10000",
            "1.50",
            "100000000",
        ] {
            let bytes = numeric_bytes(text).unwrap();
            assert_eq!(numeric_text(&bytes).as_deref(), Some(text), "{text}");
        }
        assert!(numeric_bytes("1e5").is_none());
        assert!(numeric_bytes("abc").is_none());
        assert!(numeric_bytes("").is_none());
    }

    #[test]
    fn dates_and_times_format_from_the_postgres_epoch() {
        assert_eq!(date_text(0), "2000-01-01");
        assert_eq!(date_text(-1), "1999-12-31");
        assert_eq!(date_text(9_821), "2026-11-21");
        assert_eq!(timestamp_text(0), "2000-01-01 00:00:00");
        assert_eq!(timestamp_text(-1), "1999-12-31 23:59:59.999999");
        assert_eq!(timestamp_text(i64::MAX), "infinity");
        assert_eq!(offset_text(19_800), "+05:30");
        assert_eq!(offset_text(-18_000), "-05");
    }
}
