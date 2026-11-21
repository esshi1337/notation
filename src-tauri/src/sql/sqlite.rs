//! SQLite: the file is opened read-only and never created; an authorizer
//! allows reads only, `query_only` is on, and a statement that SQLite itself
//! does not report as read-only is not stepped.
use super::{cell, guard, Collector, Column, Job, Parameter, SqlError};
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use std::time::{Duration, Instant};

fn failure(error: rusqlite::Error) -> SqlError {
    let message = match &error {
        rusqlite::Error::SqliteFailure(_, Some(message)) => message.clone(),
        other => other.to_string(),
    };
    SqlError::new("query", format!("SQLite: {message}"))
}

/// The only operations a block may perform.
fn authorize(context: AuthContext<'_>) -> Authorization {
    match context.action {
        AuthAction::Select
        | AuthAction::Read { .. }
        | AuthAction::Function { .. }
        | AuthAction::Recursive => Authorization::Allow,
        AuthAction::Pragma {
            pragma_name,
            pragma_value,
        } => {
            if guard::reporting_pragma(pragma_name, pragma_value.is_some()) {
                Authorization::Allow
            } else {
                Authorization::Deny
            }
        }
        _ => Authorization::Deny,
    }
}

pub(crate) fn open(path: &str, busy: Duration) -> Result<Connection, SqlError> {
    let file = std::path::Path::new(path);
    // Checked first for a clear message. The open flags below are what
    // guarantee the file is neither created nor written.
    match std::fs::metadata(file) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err(SqlError::new("connect", "The SQLite path is not a file.")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(SqlError::new(
                "connect",
                "The SQLite file does not exist. It is never created from a SQL block.",
            ));
        }
        Err(error) => {
            return Err(SqlError::new(
                "connect",
                format!("The SQLite file cannot be read: {error}"),
            ))
        }
    }
    // No SQLITE_OPEN_CREATE, no SQLITE_OPEN_READ_WRITE, and no
    // SQLITE_OPEN_URI: a path is a path, never `file:…?mode=rwc`.
    let connection = Connection::open_with_flags(
        file,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| {
        SqlError::new(
            "connect",
            format!("SQLite could not open the file: {}", failure(error).message),
        )
    })?;
    connection.busy_timeout(busy).map_err(failure)?;
    // Views and triggers in a file from someone else cannot call
    // side-effecting functions.
    connection
        .execute_batch("PRAGMA query_only=1; PRAGMA trusted_schema=OFF;")
        .map_err(failure)?;
    Ok(connection)
}

pub(crate) fn run(job: &Job<'_>, out: &mut Collector) -> Result<(), SqlError> {
    let deadline = Instant::now() + job.timeout;
    let connection = open(&job.profile.path, job.timeout.min(Duration::from_secs(5)))?;
    let cancel = job.cancel.clone();
    // Runs every few thousand VM steps; returning true interrupts the query.
    connection
        .progress_handler(
            2000,
            Some(move || cancel.is_cancelled() || Instant::now() >= deadline),
        )
        .map_err(failure)?;
    connection.authorizer(Some(authorize)).map_err(failure)?;
    let stopped = |error: rusqlite::Error| -> SqlError {
        let interrupted = matches!(&error, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::OperationInterrupted);
        if interrupted && job.cancel.is_cancelled() {
            SqlError::new("cancelled", "Query cancelled.")
        } else if interrupted {
            SqlError::new(
                "timeout",
                format!(
                    "The query was stopped after {} s (the connection's timeout).",
                    job.timeout.as_secs()
                ),
            )
        } else if matches!(&error, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::AuthorizationForStatementDenied)
        {
            SqlError::new("refused", "SQL blocks are read-only. This statement would change the database or its settings.")
        } else {
            failure(error)
        }
    };
    let mut statement = connection.prepare(job.sql).map_err(stopped)?;
    if !statement.readonly() {
        return Err(SqlError::new(
            "refused",
            "SQL blocks are read-only. SQLite reports that this statement writes.",
        ));
    }
    for (name, value) in &job.parameters {
        let Some(index) = statement
            .parameter_index(&format!(":{name}"))
            .map_err(failure)?
        else {
            continue;
        };
        match value {
            Parameter::Null => statement.raw_bind_parameter(index, rusqlite::types::Null),
            Parameter::Bool(value) => statement.raw_bind_parameter(index, value),
            Parameter::Integer(value) => statement.raw_bind_parameter(index, value),
            Parameter::Float(value) => statement.raw_bind_parameter(index, value),
            Parameter::Text(value) => statement.raw_bind_parameter(index, value),
        }
        .map_err(failure)?;
    }
    let count = statement.column_count();
    if count == 0 {
        return Err(SqlError::new("refused", "SQL blocks are read-only. SQLite reports that this statement does not return rows, so it was not run."));
    }
    out.set_columns(
        (0..count)
            .map(|index| Column {
                name: statement
                    .column_name(index)
                    .map(str::to_string)
                    .unwrap_or_default(),
                type_name: String::new(),
            })
            .collect(),
    )?;
    let mut rows = statement.raw_query();
    while let Some(row) = rows.next().map_err(stopped)? {
        let mut values = Vec::with_capacity(count);
        for index in 0..count {
            values.push(match row.get_ref(index).map_err(failure)? {
                ValueRef::Null => serde_json::Value::Null,
                ValueRef::Integer(value) => cell::integer(value),
                ValueRef::Real(value) => cell::float(value),
                ValueRef::Text(value) => cell::text_bytes(value),
                ValueRef::Blob(value) => cell::bytes(value),
            });
        }
        if !out.push(values) {
            break;
        }
    }
    Ok(())
}
