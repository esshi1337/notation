//! Friendly up-front checks for a SQL block, and `:name` placeholder
//! rewriting.
//!
//! This is not the security boundary. Each driver opens the database
//! read-only and sends the text as one prepared statement; this module only
//! turns the common mistakes (a second statement, an `UPDATE`) into a clear
//! message before anything is sent, and finds `:name` placeholders outside
//! strings and comments so they can be bound as real parameters.
use super::Kind;

pub const MAX_SQL_BYTES: usize = 256 * 1024;
pub const MAX_PARAMETERS: usize = 64;

#[derive(Debug, PartialEq)]
pub struct Checked {
    /// Statement text with placeholders in the driver's own syntax.
    pub sql: String,
    /// Parameter names in binding order. Postgres lists each name once
    /// (`$1` can repeat); MySQL lists one entry per `?`; SQLite keeps
    /// `:name` and lists each name once.
    pub parameters: Vec<String>,
}

/// Statement keywords that may start a block.
fn allowed_start(kind: Kind) -> &'static [&'static str] {
    match kind {
        Kind::Sqlite => &["SELECT", "WITH", "VALUES", "EXPLAIN", "PRAGMA"],
        Kind::Postgres => &["SELECT", "WITH", "VALUES", "EXPLAIN", "SHOW", "TABLE"],
        Kind::Mysql => &[
            "SELECT", "WITH", "VALUES", "EXPLAIN", "SHOW", "DESCRIBE", "DESC", "TABLE",
        ],
    }
}

/// Words that change data, schema or files wherever they appear outside a
/// string, quoted identifier or comment (a writing CTE, `EXPLAIN ANALYZE
/// DELETE`, `SELECT … INTO`).
const WRITERS: &[&str] = &[
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "UPSERT",
    "DROP",
    "ALTER",
    "CREATE",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "ATTACH",
    "DETACH",
    "VACUUM",
    "REINDEX",
    "REFRESH",
    "COPY",
    "CALL",
    "LOCK",
    "INTO",
    "SET_CONFIG",
];

/// SQLite pragmas that only report.
const READ_PRAGMAS: &[&str] = &[
    "TABLE_INFO",
    "TABLE_XINFO",
    "TABLE_LIST",
    "INDEX_LIST",
    "INDEX_INFO",
    "INDEX_XINFO",
    "FOREIGN_KEY_LIST",
    "FOREIGN_KEY_CHECK",
    "DATABASE_LIST",
    "COLLATION_LIST",
    "FUNCTION_LIST",
    "MODULE_LIST",
    "PRAGMA_LIST",
    "COMPILE_OPTIONS",
    "INTEGRITY_CHECK",
    "QUICK_CHECK",
    "USER_VERSION",
    "SCHEMA_VERSION",
    "APPLICATION_ID",
    "PAGE_COUNT",
    "PAGE_SIZE",
    "FREELIST_COUNT",
    "ENCODING",
    "DATA_VERSION",
];

/// Pragmas that are settings: they may be read, never given a value.
const SETTING_PRAGMAS: &[&str] = &[
    "USER_VERSION",
    "SCHEMA_VERSION",
    "APPLICATION_ID",
    "PAGE_SIZE",
    "ENCODING",
];

/// Whether a pragma only reports. Shared with the SQLite authorizer.
pub(crate) fn reporting_pragma(name: &str, has_value: bool) -> bool {
    let name = name.to_ascii_uppercase();
    READ_PRAGMAS.contains(&name.as_str())
        && !(has_value && SETTING_PRAGMAS.contains(&name.as_str()))
}

fn refuse(word: &str) -> String {
    format!(
        "SQL blocks are read-only. {word} is not allowed here; only one SELECT-style statement can run. The connection is opened read-only as well."
    )
}

fn identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}
fn identifier_part(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// The first keyword of a MySQL statement, past whitespace and plain
/// comments. `None` when it starts with anything else, including a `/*!`
/// comment, whose body MySQL runs as SQL.
pub(crate) fn mysql_leading_keyword(source: &str) -> Option<String> {
    let bytes = source.as_bytes();
    let mut index = 0;
    loop {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        let rest = &source[index..];
        if rest.starts_with('#')
            || (rest.starts_with("--")
                && bytes
                    .get(index + 2)
                    .is_none_or(|after| after.is_ascii_whitespace() || after.is_ascii_control()))
        {
            index += rest.find('\n')?;
        } else if rest.starts_with("/*") {
            if rest.starts_with("/*!") {
                return None;
            }
            index += rest.find("*/")? + 2;
        } else {
            break;
        }
    }
    let end = bytes[index..]
        .iter()
        .position(|byte| !identifier_part(*byte))
        .map_or(bytes.len(), |offset| index + offset);
    (end > index && identifier_start(bytes[index])).then(|| source[index..end].to_ascii_uppercase())
}

/// Check one block and rewrite its placeholders for `kind`.
pub fn check(source: &str, kind: Kind) -> Result<Checked, String> {
    if source.len() > MAX_SQL_BYTES {
        return Err("This SQL block is larger than 256 KiB.".into());
    }
    if source.contains('\0') {
        return Err("SQL cannot contain a NUL character.".into());
    }
    let bytes = source.as_bytes();
    let mut output = String::with_capacity(source.len());
    let mut parameters: Vec<String> = Vec::new();
    let mut words: Vec<String> = Vec::new();
    // Punctuation directly after each word, to tell `PRAGMA x = 1` apart.
    let mut assigned_pragma = false;
    let mut ended = false; // a `;` has been seen
    let mut index = 0;
    // Copy `source[from..to]` unchanged.
    macro_rules! copy {
        ($from:expr, $to:expr) => {
            output.push_str(&source[$from..$to])
        };
    }
    let content = |ended: bool| -> Result<(), String> {
        if ended {
            Err("Only one statement can run per SQL block. Remove everything after the first semicolon.".into())
        } else {
            Ok(())
        }
    };
    while index < bytes.len() {
        let byte = bytes[index];
        let next = bytes.get(index + 1).copied();
        // Line comments. MySQL only treats `--` as a comment before
        // whitespace; `1--1` is arithmetic there.
        let dash_comment = byte == b'-'
            && next == Some(b'-')
            && (kind != Kind::Mysql
                || bytes
                    .get(index + 2)
                    .is_none_or(|after| after.is_ascii_whitespace() || after.is_ascii_control()));
        if dash_comment || (byte == b'#' && kind == Kind::Mysql) {
            let end = source[index..]
                .find('\n')
                .map_or(bytes.len(), |offset| index + offset);
            copy!(index, end);
            index = end;
            continue;
        }
        if byte == b'/' && next == Some(b'*') {
            if kind == Kind::Mysql && bytes.get(index + 2) == Some(&b'!') {
                return Err("MySQL version comments (/*! … */) run as SQL and are not allowed in a SQL block.".into());
            }
            let mut depth = 1;
            let mut at = index + 2;
            while at < bytes.len() && depth > 0 {
                if bytes[at] == b'*' && bytes.get(at + 1) == Some(&b'/') {
                    depth -= 1;
                    at += 2;
                } else if kind == Kind::Postgres
                    && bytes[at] == b'/'
                    && bytes.get(at + 1) == Some(&b'*')
                {
                    depth += 1;
                    at += 2;
                } else {
                    at += 1;
                }
            }
            if depth > 0 {
                return Err("A /* comment is not closed.".into());
            }
            copy!(index, at);
            index = at;
            continue;
        }
        if byte.is_ascii_whitespace() {
            output.push(byte as char);
            index += 1;
            continue;
        }
        if byte == b';' {
            ended = true;
            // The terminator is not sent: prepared statements take one
            // statement and some servers reject a trailing semicolon.
            output.push(' ');
            index += 1;
            continue;
        }
        content(ended)?;
        // Quoted text: strings, quoted identifiers.
        let quote = match byte {
            b'\'' | b'"' => Some(byte),
            b'`' if kind != Kind::Postgres => Some(b'`'),
            b'[' if kind == Kind::Sqlite => Some(b']'),
            _ => None,
        };
        if let Some(close) = quote {
            // Backslash escapes: MySQL strings, and Postgres `E'…'` strings.
            let escapes = match kind {
                Kind::Mysql => byte != b'`',
                Kind::Postgres => {
                    byte == b'\''
                        && index > 0
                        && matches!(bytes[index - 1], b'E' | b'e')
                        && (index < 2 || !identifier_part(bytes[index - 2]))
                }
                Kind::Sqlite => false,
            };
            let mut at = index + 1;
            let mut closed = false;
            while at < bytes.len() {
                if escapes && bytes[at] == b'\\' {
                    at += 2;
                } else if bytes[at] == close {
                    if close != b']' && bytes.get(at + 1) == Some(&close) {
                        at += 2;
                    } else {
                        at += 1;
                        closed = true;
                        break;
                    }
                } else {
                    at += 1;
                }
            }
            if !closed || at > bytes.len() {
                return Err("A quoted string or identifier is not closed.".into());
            }
            copy!(index, at);
            index = at;
            continue;
        }
        // Postgres dollar-quoted strings: $$…$$ or $tag$…$tag$.
        if byte == b'$'
            && kind == Kind::Postgres
            && (index == 0 || !identifier_part(bytes[index - 1]))
        {
            let mut at = index + 1;
            while at < bytes.len() && identifier_part(bytes[at]) {
                at += 1;
            }
            let tag_is_name = at == index + 1 || identifier_start(bytes[index + 1]);
            if at < bytes.len() && bytes[at] == b'$' && tag_is_name {
                let tag = &source[index..=at];
                let Some(end) = source[at + 1..].find(tag) else {
                    return Err("A dollar-quoted string is not closed.".into());
                };
                let stop = at + 1 + end + tag.len();
                copy!(index, stop);
                index = stop;
                continue;
            }
        }
        if identifier_start(byte) {
            let mut at = index + 1;
            while at < bytes.len() && (identifier_part(bytes[at]) || bytes[at] == b'$') {
                at += 1;
            }
            let word = source[index..at].to_ascii_uppercase();
            if words.len() < 4096 {
                words.push(word);
            }
            copy!(index, at);
            index = at;
            continue;
        }
        if byte == b'=' && words.first().map(String::as_str) == Some("PRAGMA") {
            assigned_pragma = true;
        }
        // `:name` placeholder; not `::cast`, not `:=`.
        if byte == b':'
            && next.is_some_and(identifier_start)
            && (index == 0 || bytes[index - 1] != b':')
        {
            let mut at = index + 1;
            while at < bytes.len() && identifier_part(bytes[at]) {
                at += 1;
            }
            let name = source[index + 1..at].to_string();
            match kind {
                Kind::Postgres => {
                    let position = match parameters.iter().position(|known| *known == name) {
                        Some(position) => position,
                        None => {
                            parameters.push(name);
                            parameters.len() - 1
                        }
                    };
                    output.push('$');
                    output.push_str(&(position + 1).to_string());
                }
                Kind::Mysql => {
                    parameters.push(name);
                    output.push('?');
                }
                Kind::Sqlite => {
                    if !parameters.contains(&name) {
                        parameters.push(name);
                    }
                    copy!(index, at);
                }
            }
            if parameters.len() > MAX_PARAMETERS {
                return Err(format!(
                    "A SQL block can use at most {MAX_PARAMETERS} parameters."
                ));
            }
            index = at;
            continue;
        }
        // A positional placeholder would be bound to nothing; say so plainly.
        if (byte == b'?' && kind != Kind::Postgres)
            || (byte == b'$'
                && kind == Kind::Postgres
                && next.is_some_and(|after| after.is_ascii_digit()))
        {
            return Err("Positional placeholders are not supported. Use :name and define name in the note's properties.".into());
        }
        // Any other character, copied whole (it may be multi-byte).
        let width = source[index..].chars().next().map_or(1, char::len_utf8);
        copy!(index, index + width);
        index += width;
    }
    let Some(first) = words.first() else {
        return Err("This SQL block is empty.".into());
    };
    if !allowed_start(kind).contains(&first.as_str()) {
        return Err(refuse(first));
    }
    if let Some(writer) = words.iter().find(|word| WRITERS.contains(&word.as_str())) {
        return Err(refuse(writer));
    }
    if first == "PRAGMA" {
        // `PRAGMA schema.name`: the pragma is the last name before any argument.
        let name = words
            .iter()
            .skip(1)
            .take(2)
            .find(|word| READ_PRAGMAS.contains(&word.as_str()));
        if name.is_none() || assigned_pragma {
            return Err("Only reporting PRAGMA statements (table_info, index_list, …) can run in a SQL block.".into());
        }
        if SETTING_PRAGMAS.contains(&name.unwrap().as_str()) && output.contains('(') {
            return Err("Only reporting PRAGMA statements (table_info, index_list, …) can run in a SQL block.".into());
        }
    }
    Ok(Checked {
        sql: output.trim().to_string(),
        parameters,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(sql: &str, kind: Kind) -> Checked {
        check(sql, kind).unwrap_or_else(|error| panic!("{sql}: {error}"))
    }
    fn refused(sql: &str, kind: Kind) -> String {
        check(sql, kind).expect_err(sql)
    }

    #[test]
    fn accepts_reads_and_one_trailing_semicolon() {
        for kind in [Kind::Sqlite, Kind::Postgres, Kind::Mysql] {
            assert_eq!(ok("select 1;", kind).sql, "select 1");
            ok(
                "  -- note\nWITH a AS (SELECT 1) SELECT * FROM a ; -- done\n",
                kind,
            );
            ok(
                "select 'insert; update' as \"delete\", updated_at, created from t",
                kind,
            );
            ok("explain select 1", kind);
            ok("values (1), (2)", kind);
        }
        ok("show tables", Kind::Mysql);
        ok("describe customers", Kind::Mysql);
        ok("select `drop` from t", Kind::Mysql);
        ok("select [drop] from t", Kind::Sqlite);
        ok("select $body$ drop table x; $body$, $$;$$", Kind::Postgres);
        ok(
            "select a[1], '{}'::jsonb /* outer /* nested ; */ still */ from t",
            Kind::Postgres,
        );
        ok("PRAGMA table_info(customers)", Kind::Sqlite);
        ok("pragma main.index_list('customers')", Kind::Sqlite);
        ok("pragma user_version", Kind::Sqlite);
    }

    #[test]
    fn refuses_writers_ddl_session_changes_and_second_statements() {
        for kind in [Kind::Sqlite, Kind::Postgres, Kind::Mysql] {
            for sql in [
                "insert into t values (1)",
                "UPDATE t SET a=1",
                "delete from t",
                "drop table t",
                "create table t(a)",
                "alter table t add b",
                "truncate t",
                "begin",
                "commit",
                "set x = 1",
                "vacuum",
                "attach 'x' as y",
                "grant all on t to u",
                "call p()",
                "with d as (delete from t returning *) select * from d",
                "explain analyze delete from t",
                "select * into copy_t from t",
                "select 1; select 2",
                "select 1; drop table t",
                "select 1;;drop table t",
                "",
                "   -- only a comment",
                "select 'open",
                "select 1 /* open",
            ] {
                refused(sql, kind);
            }
        }
        assert!(refused("select 1; select 2", Kind::Postgres).contains("Only one statement"));
        assert!(refused("update t set a=1", Kind::Postgres).contains("UPDATE"));
        refused("select 1 into outfile '/tmp/x'", Kind::Mysql);
        refused("select /*!50000 1; drop table t */ 1", Kind::Mysql);
        refused(
            "select set_config('transaction_read_only','off',true)",
            Kind::Postgres,
        );
        refused("copy t to '/tmp/x'", Kind::Postgres);
        refused("pragma query_only = 0", Kind::Sqlite);
        refused("pragma query_only(0)", Kind::Sqlite);
        refused("pragma journal_mode=delete", Kind::Sqlite);
        refused("pragma user_version = 3", Kind::Sqlite);
        refused("pragma user_version(3)", Kind::Sqlite);
        refused("pragma writable_schema", Kind::Sqlite);
    }

    #[test]
    fn finds_the_leading_mysql_keyword_past_plain_comments_only() {
        assert_eq!(
            mysql_leading_keyword("  -- c\n/* c */ # c\n show tables").as_deref(),
            Some("SHOW")
        );
        assert_eq!(
            mysql_leading_keyword("explain select 1").as_deref(),
            Some("EXPLAIN")
        );
        assert_eq!(mysql_leading_keyword("/*! call p() */ show tables"), None);
        assert_eq!(mysql_leading_keyword("(select 1)"), None);
        assert_eq!(mysql_leading_keyword("--x\nshow tables"), None);
        assert_eq!(mysql_leading_keyword(""), None);
    }

    #[test]
    fn statement_boundaries_follow_each_dialect() {
        // Postgres: a backslash does not escape a quote in a standard string.
        refused(r"select 'a\'; drop table t; --'", Kind::Postgres);
        ok(r"select E'a\'; still text'", Kind::Postgres);
        // MySQL: it does.
        ok(r"select 'a\'; still text'", Kind::Mysql);
        // MySQL: `--` without a following space is arithmetic, not a comment.
        refused("select 1--1; drop table t", Kind::Mysql);
        ok("select 1 -- 1; drop table t", Kind::Mysql);
        refused("select 1 # c\n; drop table t", Kind::Mysql);
        // `#` is an operator elsewhere, not a comment.
        refused("select 1 # 2; drop table t", Kind::Postgres);
        // Postgres nests block comments; the others end at the first `*/`.
        refused("select 1 /* a /* b */ ; drop table t -- */", Kind::Sqlite);
        ok("select 1 /* a /* b */ ; drop table t -- */", Kind::Postgres);
    }

    #[test]
    fn rewrites_named_parameters_outside_strings_only() {
        let postgres = ok(
            "select :id, ':id', x::text, :name, :id from t -- :not\n",
            Kind::Postgres,
        );
        assert_eq!(
            postgres.sql,
            "select $1, ':id', x::text, $2, $1 from t -- :not"
        );
        assert_eq!(postgres.parameters, ["id", "name"]);
        let mysql = ok("select :id, \":id\", :name, :id, @v := 1", Kind::Mysql);
        assert_eq!(mysql.sql, "select ?, \":id\", ?, ?, @v := 1");
        assert_eq!(mysql.parameters, ["id", "name", "id"]);
        let sqlite = ok("select :id, :id, :name", Kind::Sqlite);
        assert_eq!(sqlite.sql, "select :id, :id, :name");
        assert_eq!(sqlite.parameters, ["id", "name"]);
        refused("select ?", Kind::Mysql);
        refused("select $1", Kind::Postgres);
    }
}
