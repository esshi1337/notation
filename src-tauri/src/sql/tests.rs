//! Tests for SQL blocks. The SQLite and credential tests always run. The
//! Postgres and MySQL tests need throwaway servers and run only when
//! `NOTATION_SQL_TEST_POSTGRES` / `NOTATION_SQL_TEST_MYSQL` are set
//! (`host:port:user:password:database`); `tests/sql-servers.sh` starts and
//! seeds them. Driver-level tests call the drivers directly, skipping the
//! friendly SQL check, to prove the database itself refuses writes.
use super::secrets::{MemoryStore, NoKeychain, Secret, SecretStore};
use super::*;
use crate::storage::Database;
use std::path::{Path, PathBuf};

const PASSWORD: &str = "dummy-Pa55word-7f3a91-do-not-leak";

fn sqlite_profile(path: &Path) -> Profile {
    Profile {
        name: "local".into(),
        kind: Kind::Sqlite,
        path: path.to_string_lossy().into_owned(),
        host: String::new(),
        port: 0,
        database: String::new(),
        user: String::new(),
        tls_mode: TlsMode::Disable,
        ca_file: String::new(),
        row_limit: DEFAULT_ROW_LIMIT,
        timeout_seconds: 10,
        password_storage: PasswordStorage::None,
    }
}

fn seeded(directory: &Path) -> PathBuf {
    let path = directory.join("shop.sqlite3");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, balance REAL, photo BLOB, note TEXT);
             INSERT INTO customers VALUES (1,'Ada',12.5,x'00ff10',NULL),(2,'Grace',-3.0,NULL,'<b>bold</b>'),(3,'Linus',9007199254740993,NULL,'x');
             CREATE TABLE numbers(n INTEGER PRIMARY KEY);
             WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<5000) INSERT INTO numbers SELECT n FROM c;
             CREATE INDEX customers_name ON customers(name);
             CREATE VIEW names AS SELECT name FROM customers;",
        )
        .unwrap();
    drop(connection);
    path
}

/// Run through a driver directly: no `guard::check`.
fn raw(profile: &Profile, password: Option<&str>, sql: &str, parameters: Vec<(String, Parameter)>, cancel: Arc<Cancel>) -> Result<Collector, SqlError> {
    let secret = password.map(|value| Secret::new(value.to_string()));
    let job = Job { profile, password: secret.as_ref(), sql, parameters, timeout: Duration::from_secs(u64::from(profile.timeout_seconds)), cancel };
    let mut collector = Collector::new(profile.row_limit);
    match profile.kind {
        Kind::Sqlite => sqlite::run(&job, &mut collector)?,
        Kind::Postgres => runtime()?.block_on(postgres::run(&job, &mut collector))?,
        Kind::Mysql => runtime()?.block_on(mysql::run(&job, &mut collector))?,
    }
    Ok(collector)
}
fn direct(profile: &Profile, password: Option<&str>, sql: &str) -> Result<Collector, SqlError> {
    raw(profile, password, sql, Vec::new(), Arc::new(Cancel::default()))
}

fn service(directory: &Path, keychain: Box<dyn SecretStore>) -> Service {
    Service::with_keychain(Database::open(&directory.join("state.sqlite3")), keychain)
}
fn request(connection: &str, sql: &str) -> RunRequest {
    RunRequest { id: format!("run-{}", sql.len()), connection: connection.into(), sql: sql.into(), parameters: BTreeMap::new() }
}

#[test]
fn sqlite_reads_every_value_kind_as_text_safe_cells() {
    let directory = tempfile::tempdir().unwrap();
    let profile = sqlite_profile(&seeded(directory.path()));
    let result = direct(&profile, None, "select id, name, balance, photo, note from customers order by id").unwrap();
    assert_eq!(result.columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(), ["id", "name", "balance", "photo", "note"]);
    assert_eq!(result.rows[0], vec![json!(1), json!("Ada"), json!(12.5), json!({"t":"bytes","v":"00ff10","n":3}), Value::Null]);
    // Markup in data is data: it stays a plain string for the UI to show as text.
    assert_eq!(result.rows[1][4], json!("<b>bold</b>"));
    // An integer beyond 2^53 is carried as text so JavaScript cannot round it.
    assert_eq!(direct(&profile, None, "select 9007199254740993").unwrap().rows[0][0], json!({"t":"number","v":"9007199254740993"}));
    assert_eq!(result.truncated, None);
}

#[test]
fn sqlite_refuses_every_write_at_the_database_and_leaves_the_file_unchanged() {
    let directory = tempfile::tempdir().unwrap();
    let path = seeded(directory.path());
    let profile = sqlite_profile(&path);
    let before = std::fs::read(&path).unwrap();
    let attached = directory.path().join("attached.sqlite3");
    let writes = [
        "INSERT INTO customers(name) VALUES ('Mallory')".to_string(),
        "UPDATE customers SET name='x'".into(),
        "DELETE FROM customers".into(),
        "CREATE TABLE made(a)".into(),
        "DROP TABLE customers".into(),
        "ALTER TABLE customers ADD COLUMN extra".into(),
        "CREATE INDEX made_index ON customers(name)".into(),
        "DROP VIEW names".into(),
        format!("ATTACH DATABASE '{}' AS other", attached.display()),
        "DETACH DATABASE main".into(),
        "PRAGMA user_version=42".into(),
        "PRAGMA journal_mode=WAL".into(),
        "PRAGMA query_only=0".into(),
        "PRAGMA writable_schema=1".into(),
        "VACUUM".into(),
        format!("VACUUM INTO '{}'", attached.display()),
        "REINDEX".into(),
        "BEGIN IMMEDIATE".into(),
        "REPLACE INTO customers(id,name) VALUES (1,'x')".into(),
        "WITH c AS (SELECT 1) INSERT INTO customers(name) SELECT 'x' FROM c".into(),
    ];
    for sql in &writes {
        // The database refuses, with the SQL check bypassed.
        let error = direct(&profile, None, sql).err().unwrap_or_else(|| panic!("{sql} ran"));
        assert!(matches!(error.code, "refused" | "query"), "{sql}: {error:?}");
        // The friendly check refuses first in normal use.
        assert!(guard::check(sql, Kind::Sqlite).is_err(), "{sql} passed the check");
    }
    assert_eq!(std::fs::read(&path).unwrap(), before, "the database file changed");
    assert!(!attached.exists(), "ATTACH or VACUUM INTO created a file");
    let version = direct(&profile, None, "PRAGMA user_version").unwrap();
    assert_eq!(version.rows[0][0], json!(0));
    assert_eq!(direct(&profile, None, "select count(*) from customers").unwrap().rows[0][0], json!(3));
    // Reporting pragmas still work.
    assert_eq!(direct(&profile, None, "PRAGMA table_info(customers)").unwrap().rows.len(), 5);
}

#[test]
fn sqlite_never_creates_a_missing_file_and_rejects_non_files() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("missing.sqlite3");
    let error = direct(&sqlite_profile(&missing), None, "select 1").unwrap_err();
    assert_eq!(error.code, "connect");
    assert!(error.message.contains("does not exist"), "{error:?}");
    assert!(!missing.exists());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0, "something was created");
    assert_eq!(direct(&sqlite_profile(directory.path()), None, "select 1").unwrap_err().code, "connect");
    // A URI is not interpreted: it is a relative path, refused by validation.
    let mut uri = sqlite_profile(Path::new("file:made.sqlite3?mode=rwc"));
    uri.name = "uri".into();
    assert_eq!(uri.validated().unwrap_err().code, "invalid");
}

#[test]
fn sqlite_applies_row_cell_and_size_limits() {
    let directory = tempfile::tempdir().unwrap();
    let mut profile = sqlite_profile(&seeded(directory.path()));
    profile.row_limit = 10;
    let limited = direct(&profile, None, "select n from numbers order by n").unwrap();
    assert_eq!((limited.rows.len(), limited.truncated), (10, Some("rows")));
    let exact = direct(&profile, None, "select n from numbers order by n limit 10").unwrap();
    assert_eq!((exact.rows.len(), exact.truncated), (10, None));
    // One long cell is cut to the cell limit and says how long it was.
    let long = direct(&profile, None, "select printf('%.*c', 20000, 'x')").unwrap();
    assert_eq!(long.rows[0][0]["t"], "text");
    assert_eq!(long.rows[0][0]["n"], 20000);
    assert_eq!(long.rows[0][0]["v"].as_str().unwrap().len(), MAX_CELL_BYTES);
    // Many large rows stop at the total size cap, below the row limit.
    profile.row_limit = MAX_ROW_LIMIT;
    let big = direct(&profile, None, "select printf('%.*c', 8000, 'x') from numbers").unwrap();
    assert_eq!(big.truncated, Some("size"));
    assert!(big.rows.len() < 5000 && big.rows.len() * 8000 <= MAX_RESULT_BYTES, "{}", big.rows.len());
}

const SLOW_SQLITE: &str = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c";

#[test]
fn sqlite_stops_at_the_timeout() {
    let directory = tempfile::tempdir().unwrap();
    let mut profile = sqlite_profile(&seeded(directory.path()));
    profile.timeout_seconds = 1;
    let started = Instant::now();
    let error = direct(&profile, None, SLOW_SQLITE).unwrap_err();
    assert_eq!(error.code, "timeout", "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
}

#[test]
fn sqlite_cancel_interrupts_a_running_query() {
    let directory = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let path = seeded(directory.path());
    let service = Arc::new(service(state.path(), Box::new(MemoryStore::default())));
    service.save(sqlite_profile(&path), None, None).unwrap();
    assert!(!service.cancel("slow"), "nothing is running yet");
    let worker = {
        let service = service.clone();
        std::thread::spawn(move || service.run(RunRequest { id: "slow".into(), connection: "local".into(), sql: SLOW_SQLITE.into(), parameters: BTreeMap::new() }))
    };
    let started = Instant::now();
    while !service.cancel("slow") {
        assert!(started.elapsed() < Duration::from_secs(5), "the query never registered");
        std::thread::sleep(Duration::from_millis(10));
    }
    let error = worker.join().unwrap().unwrap_err();
    assert_eq!(error.code, "cancelled", "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(5));
    // The id is free again and the connection still works.
    assert_eq!(service.run(request("local", "select 1")).unwrap().rows[0][0], json!(1));
}

#[test]
fn parameters_are_bound_not_interpolated() {
    let directory = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let service = service(state.path(), Box::new(MemoryStore::default()));
    service.save(sqlite_profile(&seeded(directory.path())), None, None).unwrap();
    let mut run = request("local", "select name, :who as who, typeof(:id) from customers where id = :id or name = :who");
    // A value that would change the statement if it were pasted into it.
    run.parameters.insert("who".into(), json!("x' OR 1=1; DROP TABLE customers; --"));
    run.parameters.insert("id".into(), json!(2));
    let result = service.run(run).unwrap();
    assert_eq!(result.rows, vec![vec![json!("Grace"), json!("x' OR 1=1; DROP TABLE customers; --"), json!("integer")]]);
    let missing = service.run(request("local", "select :absent")).unwrap_err();
    assert_eq!(missing.code, "invalid");
    assert!(missing.message.contains(":absent"));
    let mut list = request("local", "select :items");
    list.parameters.insert("items".into(), json!([1, 2]));
    assert_eq!(service.run(list).unwrap_err().code, "invalid");
    // A placeholder inside a string is text.
    assert_eq!(service.run(request("local", "select ':id'")).unwrap().rows[0][0], json!(":id"));
}

#[test]
fn the_service_refuses_writes_unknown_connections_and_second_statements_with_clear_messages() {
    let directory = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let service = service(state.path(), Box::new(MemoryStore::default()));
    service.save(sqlite_profile(&seeded(directory.path())), None, None).unwrap();
    let unknown = service.run(request("analytics", "select 1")).unwrap_err();
    assert_eq!(unknown.code, "unknown_connection");
    assert_eq!(unknown.message, "No connection named analytics — add it in Settings → Databases.");
    for sql in ["delete from customers", "select 1; delete from customers", "drop table customers"] {
        assert_eq!(service.run(request("local", sql)).unwrap_err().code, "refused", "{sql}");
    }
    assert_eq!(service.run(request("local", "select count(*) from customers")).unwrap().rows[0][0], json!(3));
}

fn network_profile(name: &str, storage: PasswordStorage) -> Profile {
    Profile {
        name: name.into(),
        kind: Kind::Postgres,
        path: String::new(),
        host: "db.example.test".into(),
        port: 0,
        database: "app".into(),
        user: "reader".into(),
        tls_mode: TlsMode::Require,
        ca_file: String::new(),
        row_limit: DEFAULT_ROW_LIMIT,
        timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
        password_storage: storage,
    }
}

/// Every file of the state database, WAL and index included.
fn state_bytes(directory: &Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    for entry in std::fs::read_dir(directory).unwrap() {
        bytes.extend(std::fs::read(entry.unwrap().path()).unwrap());
    }
    bytes
}
fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle.as_bytes())
}

#[test]
fn passwords_go_to_the_keychain_only_and_are_never_returned_or_written_to_state() {
    let state = tempfile::tempdir().unwrap();
    let keychain = Arc::new(MemoryStore::default());
    let service = service(state.path(), Box::new(keychain.clone()));
    let saved = service.save(network_profile("analytics", PasswordStorage::Keychain), Some(PASSWORD.into()), None).unwrap();
    assert_eq!(saved.password_state, "keychain");
    assert_eq!(saved.profile.port, 5432, "the default port is filled in");
    assert_eq!(keychain.get("analytics").unwrap().unwrap().expose(), PASSWORD);
    // Nothing the UI receives carries the password.
    let listed = serde_json::to_string(&service.list().unwrap()).unwrap();
    assert!(listed.contains("\"passwordState\":\"keychain\"") && !listed.contains(PASSWORD), "{listed}");
    assert!(!serde_json::to_string(&saved).unwrap().contains(PASSWORD));
    assert!(!format!("{:?}", Secret::new(PASSWORD.into())).contains(PASSWORD));
    // Editing without a new password keeps the stored one.
    let mut edited = network_profile("analytics", PasswordStorage::Keychain);
    edited.host = "db2.example.test".into();
    service.save(edited, None, Some("analytics".into())).unwrap();
    assert_eq!(keychain.get("analytics").unwrap().unwrap().expose(), PASSWORD);
    // Renaming moves the entry.
    service.save(network_profile("warehouse", PasswordStorage::Keychain), None, Some("analytics".into())).unwrap();
    assert!(keychain.get("analytics").unwrap().is_none());
    assert_eq!(keychain.get("warehouse").unwrap().unwrap().expose(), PASSWORD);
    assert_eq!(service.list().unwrap().connections.len(), 1);
    // Not in the state database, its WAL or the index, even before a checkpoint.
    assert!(!contains(&state_bytes(state.path()), PASSWORD));
    assert!(contains(&state_bytes(state.path()), "db2.example.test"), "the profile itself is stored");
    // Switching away from the keychain removes the entry; so does deleting.
    service.save(network_profile("warehouse", PasswordStorage::None), None, Some("warehouse".into())).unwrap();
    assert!(keychain.get("warehouse").unwrap().is_none());
    service.save(network_profile("warehouse", PasswordStorage::Keychain), Some(PASSWORD.into()), Some("warehouse".into())).unwrap();
    service.delete("warehouse").unwrap();
    assert!(keychain.get("warehouse").unwrap().is_none());
    assert!(service.list().unwrap().connections.is_empty());
    assert_eq!(service.delete("warehouse").unwrap_err().code, "unknown_connection");
    assert!(!contains(&state_bytes(state.path()), PASSWORD));
}

#[test]
fn a_profile_cannot_carry_a_password_field() {
    let with_password = r#"{"name":"a","kind":"postgres","host":"h","user":"u","password":"secret"}"#;
    assert!(serde_json::from_str::<Profile>(with_password).is_err());
    let without = r#"{"name":"a","kind":"postgres","host":"h","user":"u"}"#;
    let profile = serde_json::from_str::<Profile>(without).unwrap().validated().unwrap();
    assert_eq!((profile.row_limit, profile.timeout_seconds, profile.tls_mode), (1000, 30, TlsMode::Prefer));
}

#[test]
fn without_a_keychain_nothing_falls_back_to_disk_and_ask_every_session_works_in_memory() {
    let state = tempfile::tempdir().unwrap();
    let service = service(state.path(), Box::new(NoKeychain("No keychain in this test.".into())));
    let list = service.list().unwrap();
    assert!(!list.keychain_available);
    assert_eq!(list.keychain_reason.as_deref(), Some("No keychain in this test."));
    // Asking for keychain storage fails, and saves nothing at all.
    let refused = service.save(network_profile("analytics", PasswordStorage::Keychain), Some(PASSWORD.into()), None).unwrap_err();
    assert_eq!(refused.code, "keychain");
    assert!(service.list().unwrap().connections.is_empty());
    // Ask every session: the password is held in memory.
    let saved = service.save(network_profile("analytics", PasswordStorage::Session), None, None).unwrap();
    assert_eq!(saved.password_state, "needed");
    let needs = service.run(request("analytics", "select 1")).unwrap_err();
    assert_eq!(needs.code, "password_required");
    service.unlock("analytics", PASSWORD.into()).unwrap();
    assert_eq!(service.list().unwrap().connections[0].password_state, "session");
    assert!(!contains(&state_bytes(state.path()), PASSWORD));
    assert!(!serde_json::to_string(&service.list().unwrap()).unwrap().contains(PASSWORD));
    // A new session (a new service on the same state) has forgotten it.
    drop(service);
    let reopened = self::service(state.path(), Box::new(NoKeychain("No keychain in this test.".into())));
    assert_eq!(reopened.list().unwrap().connections[0].password_state, "needed");
}

#[test]
fn profiles_are_validated() {
    let state = tempfile::tempdir().unwrap();
    let service = service(state.path(), Box::new(MemoryStore::default()));
    let invalid = |change: &dyn Fn(&mut Profile)| {
        let mut profile = network_profile("ok", PasswordStorage::None);
        change(&mut profile);
        assert_eq!(service.save(profile, None, None).unwrap_err().code, "invalid");
    };
    invalid(&|profile| profile.name = "has space".into());
    invalid(&|profile| profile.name = "1st".into());
    invalid(&|profile| profile.name = String::new());
    invalid(&|profile| profile.host = String::new());
    invalid(&|profile| profile.host = "a b".into());
    invalid(&|profile| profile.user = String::new());
    invalid(&|profile| profile.row_limit = 0);
    invalid(&|profile| profile.row_limit = MAX_ROW_LIMIT + 1);
    invalid(&|profile| profile.timeout_seconds = 0);
    invalid(&|profile| profile.timeout_seconds = MAX_TIMEOUT_SECONDS + 1);
    invalid(&|profile| profile.database = "a\nb".into());
    invalid(&|profile| {
        profile.tls_mode = TlsMode::VerifyFull;
        profile.ca_file = "relative.pem".into();
    });
    service.save(network_profile("ok", PasswordStorage::None), None, None).unwrap();
    // Names are unique whatever their letter case.
    assert_eq!(service.save(network_profile("OK", PasswordStorage::None), None, None).unwrap_err().code, "invalid");
    assert_eq!(service.save(network_profile("gone", PasswordStorage::None), None, Some("missing".into())).unwrap_err().code, "invalid");
    assert_eq!(service.save(network_profile("pw", PasswordStorage::Keychain), None, None).unwrap_err().code, "invalid");
}

#[test]
fn error_messages_are_scrubbed_of_the_password() {
    let secret = Secret::new(PASSWORD.into());
    let scrubbed = secrets::scrub(&format!("auth failed for reader:{PASSWORD}@host"), Some(&secret));
    assert_eq!(scrubbed, "auth failed for reader:•••@host");
    assert_eq!(secrets::scrub("plain", Some(&secret)), "plain");
    assert_eq!(secrets::scrub("plain", None), "plain");
}

// ---- Postgres and MySQL: only with throwaway servers ----

struct Server {
    profile: Profile,
    password: String,
}
fn server(variable: &str, kind: Kind) -> Option<Server> {
    let value = std::env::var(variable).ok().filter(|value| !value.is_empty())?;
    let parts: Vec<&str> = value.splitn(5, ':').collect();
    assert_eq!(parts.len(), 5, "{variable} must be host:port:user:password:database");
    Some(Server {
        profile: Profile {
            name: "server".into(),
            kind,
            path: String::new(),
            host: parts[0].into(),
            port: parts[1].parse().unwrap(),
            database: parts[4].into(),
            user: parts[2].into(),
            tls_mode: TlsMode::Disable,
            ca_file: String::new(),
            row_limit: DEFAULT_ROW_LIMIT,
            timeout_seconds: 10,
            password_storage: PasswordStorage::Keychain,
        },
        password: parts[3].into(),
    })
}
fn postgres_server() -> Option<Server> {
    server("NOTATION_SQL_TEST_POSTGRES", Kind::Postgres)
}
fn mysql_server() -> Option<Server> {
    server("NOTATION_SQL_TEST_MYSQL", Kind::Mysql)
}
impl Server {
    fn direct(&self, sql: &str) -> Result<Collector, SqlError> {
        direct(&self.profile, Some(&self.password), sql)
    }
    fn count(&self, sql: &str) -> Value {
        self.direct(sql).unwrap_or_else(|error| panic!("{sql}: {error:?}")).rows[0][0].clone()
    }
    fn with(&self, change: impl FnOnce(&mut Profile)) -> Server {
        let mut profile = self.profile.clone();
        change(&mut profile);
        Server { profile, password: self.password.clone() }
    }
    /// A service with this server saved as `server`, password in a mock keychain.
    fn service(&self, state: &Path) -> Service {
        let service = service(state, Box::new(MemoryStore::default()));
        service.save(self.profile.clone(), Some(self.password.clone()), None).unwrap();
        service
    }
}

#[test]
fn postgres_decodes_common_types() {
    let Some(server) = postgres_server() else { return };
    let result = server
        .direct(
            "select 42::int4, 9007199254740993::int8, 12345.6789::numeric, 0.1::float4, 'héllo'::text, true, null::text,
                    date '2026-11-21', timestamp '2026-11-21 13:05:09.5', timestamptz '2026-11-21 13:05:09+02', time '07:08:09',
                    '{\"a\":1}'::json, '{\"b\": [1,2]}'::jsonb, '\\x00ff'::bytea, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid,
                    array[1,2,null]::int4[], array['x','y']::text[], interval '1 day 02:03:04', inet '10.0.0.1', -0.5::numeric, 1e20::numeric,
                    point(1,2)",
        )
        .unwrap();
    assert_eq!(
        result.rows[0],
        vec![
            json!(42),
            json!({"t":"number","v":"9007199254740993"}),
            json!({"t":"number","v":"12345.6789"}),
            json!(0.1),
            json!("héllo"),
            json!(true),
            Value::Null,
            json!({"t":"date","v":"2026-11-21"}),
            json!({"t":"datetime","v":"2026-11-21 13:05:09.500000"}),
            json!({"t":"datetime","v":"2026-11-21 11:05:09+00"}),
            json!({"t":"time","v":"07:08:09"}),
            json!({"t":"json","v":"{\"a\":1}"}),
            json!({"t":"json","v":"{\"b\": [1, 2]}"}),
            json!({"t":"bytes","v":"00ff","n":2}),
            json!("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"),
            json!({"t":"json","v":"[1,2,null]"}),
            json!({"t":"json","v":"[\"x\",\"y\"]"}),
            json!({"t":"other","v":"1 day 02:03:04"}),
            json!("10.0.0.1"),
            json!({"t":"number","v":"-0.5"}),
            json!({"t":"number","v":"100000000000000000000"}),
            json!({"t":"other","v":"⟨point: cast to text to display⟩"}),
        ]
    );
    assert_eq!(result.columns[2].type_name, "numeric");
    assert_eq!(server.count("select count(*) from customers"), json!(3));
}

#[test]
fn postgres_refuses_writes_even_for_a_superuser() {
    let Some(server) = postgres_server() else { return };
    assert_eq!(server.count("select rolsuper from pg_roles where rolname = current_user"), json!(true), "the test must connect as a superuser");
    let writes = [
        "insert into customers(id, name) values (99, 'Mallory')",
        "update customers set name = 'x'",
        "delete from customers",
        "create table made(a int)",
        "drop table customers",
        "truncate customers",
        "alter table customers add column extra int",
        "create index made_index on customers(name)",
        "select nextval('customers_seq')",
        "with gone as (delete from customers returning *) select count(*) from gone",
        "select * into made from customers",
        "grant all on customers to public",
        "comment on table customers is 'x'",
        // Lifting the read-only mode from inside the transaction.
        "do $$ begin perform set_config('transaction_read_only', 'off', true); insert into customers(id, name) values (98, 'do'); end $$",
        "do $$ begin set transaction read write; insert into customers(id, name) values (97, 'do'); end $$",
        "do $$ begin execute 'set local transaction_read_only = off'; delete from customers; end $$",
        "select set_config('transaction_read_only', 'off', true), write_customer(96)",
        "select write_customer(95)",
        "call write_customer_procedure(94)",
        "copy customers to program 'touch /tmp/notation-test-copy'",
        "copy (select 1) to '/tmp/notation-test-copy'",
        "set transaction read write",
        // A second statement cannot ride along in a prepared statement.
        "select 1; delete from customers",
    ];
    for sql in writes {
        let error = server.direct(sql).err().unwrap_or_else(|| panic!("{sql} ran"));
        assert!(matches!(error.code, "refused" | "query"), "{sql}: {error:?}");
    }
    assert_eq!(server.count("select count(*) from customers"), json!(3));
    assert_eq!(server.count("select count(*) from pg_tables where tablename = 'made'"), json!(0));
    assert_eq!(server.count("select last_value from customers_seq"), json!(1));
    // Turning the session default off does not outlive the run: each run is
    // a new connection inside a new read-only transaction.
    let _ = server.direct("set default_transaction_read_only = off");
    assert!(server.direct("delete from customers").is_err());
    assert_eq!(server.count("select count(*) from customers"), json!(3));
    // Through the service the friendly check answers first.
    let state = tempfile::tempdir().unwrap();
    let service = server.service(state.path());
    let refused = service.run(request("server", "delete from customers")).unwrap_err();
    assert_eq!(refused.code, "refused");
    assert!(refused.message.contains("DELETE"));
    assert_eq!(service.run(request("server", "select count(*) from customers")).unwrap().rows[0][0], json!(3));
}

#[test]
fn postgres_binds_parameters_by_inferred_type() {
    let Some(server) = postgres_server() else { return };
    let state = tempfile::tempdir().unwrap();
    let service = server.service(state.path());
    let mut run = request("server", "select name from customers where id = :id and balance > :floor and active = :active and name <> :other and created_at > :since::text::timestamp");
    run.parameters = BTreeMap::from([
        ("id".into(), json!(2)),
        ("floor".into(), json!(-10.25)),
        ("active".into(), json!(true)),
        ("other".into(), json!("x'; drop table customers; --")),
        ("since".into(), json!("2020-01-01")),
    ]);
    assert_eq!(service.run(run).unwrap().rows, vec![vec![json!("Grace")]]);
    let mut wrong = request("server", "select name from customers where id = :id");
    wrong.parameters.insert("id".into(), json!("two"));
    let error = service.run(wrong).unwrap_err();
    assert!(error.message.contains(":id") && error.message.contains("int4"), "{error:?}");
    let mut uncast = request("server", "select :day = date '2026-01-01'");
    uncast.parameters.insert("day".into(), json!("2026-01-01"));
    assert!(service.run(uncast).unwrap_err().message.contains(":day::text::date"));
    assert_eq!(server.count("select count(*) from customers"), json!(3));
}

#[test]
fn postgres_limits_rows_times_out_and_cancels_on_the_server() {
    let Some(server) = postgres_server() else { return };
    let limited = server.with(|profile| profile.row_limit = 100).direct("select * from generate_series(1, 5000000)").unwrap();
    assert_eq!((limited.rows.len(), limited.truncated), (100, Some("rows")));
    let started = Instant::now();
    let error = server.with(|profile| profile.timeout_seconds = 1).direct("select pg_sleep(30)").unwrap_err();
    assert_eq!(error.code, "timeout", "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(6), "{:?}", started.elapsed());
    // Cancel: the statement stops on the server, not only in the client.
    let cancel = Arc::new(Cancel::default());
    let worker = {
        let (profile, password, cancel) = (server.profile.clone(), server.password.clone(), cancel.clone());
        std::thread::spawn(move || raw(&profile, Some(&password), "select pg_sleep(30) /* notation-cancel-test */", Vec::new(), cancel).map(|_| ()))
    };
    let running = "select count(*) from pg_stat_activity where query like '%notation-cancel-test%' and state = 'active' and pid <> pg_backend_pid()";
    let started = Instant::now();
    while server.count(running) != json!(1) {
        assert!(started.elapsed() < Duration::from_secs(8), "the query never started");
        std::thread::sleep(Duration::from_millis(50));
    }
    let cancelled_at = Instant::now();
    cancel.cancel();
    assert_eq!(worker.join().unwrap().unwrap_err().code, "cancelled");
    assert!(cancelled_at.elapsed() < Duration::from_secs(5), "{:?}", cancelled_at.elapsed());
    let stopped = Instant::now();
    while server.count(running) != json!(0) {
        assert!(stopped.elapsed() < Duration::from_secs(5), "pg_sleep kept running on the server after cancel");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn postgres_tls_modes() {
    let Some(server) = postgres_server() else { return };
    let encrypted = "select ssl from pg_stat_ssl where pid = pg_backend_pid()";
    assert_eq!(server.count(encrypted), json!(false), "disable connects in the clear");
    assert_eq!(server.with(|profile| profile.tls_mode = TlsMode::Require).count(encrypted), json!(true));
    assert_eq!(server.with(|profile| profile.tls_mode = TlsMode::Prefer).count(encrypted), json!(true));
    // verify-full without the test CA: the self-signed server is not trusted.
    let untrusted = server.with(|profile| profile.tls_mode = TlsMode::VerifyFull).direct("select 1").unwrap_err();
    assert_eq!(untrusted.code, "connect", "{untrusted:?}");
    if let Ok(ca) = std::env::var("NOTATION_SQL_TEST_CA") {
        let verified = server.with(|profile| {
            profile.tls_mode = TlsMode::VerifyFull;
            profile.ca_file = ca.clone();
            profile.host = "localhost".into();
        });
        assert_eq!(verified.count(encrypted), json!(true));
        // The right CA, the wrong host name.
        let wrong_host = server.with(|profile| {
            profile.tls_mode = TlsMode::VerifyFull;
            profile.ca_file = ca.clone();
            profile.host = "127.0.0.1".into();
        });
        assert_eq!(wrong_host.direct("select 1").unwrap_err().code, "connect");
    }
}

#[test]
fn network_errors_never_contain_the_password() {
    for server in [postgres_server(), mysql_server()].into_iter().flatten() {
        let state = tempfile::tempdir().unwrap();
        let service = service(state.path(), Box::new(MemoryStore::default()));
        // A wrong password, and a port nothing listens on.
        service.save(server.profile.clone(), Some(PASSWORD.into()), None).unwrap();
        let rejected = service.run(request("server", "select 1")).unwrap_err();
        assert_eq!(rejected.code, "connect", "{rejected:?}");
        assert!(!rejected.message.contains(PASSWORD), "{rejected:?}");
        let mut closed = server.profile.clone();
        closed.port = 1;
        service.save(closed, Some(PASSWORD.into()), Some("server".into())).unwrap();
        let refused = service.run(request("server", "select 1")).unwrap_err();
        assert_eq!(refused.code, "connect", "{refused:?}");
        assert!(!refused.message.contains(PASSWORD), "{refused:?}");
        assert!(!contains(&state_bytes(state.path()), PASSWORD));
        // Test connection reports the server and takes a typed password.
        let tested = service.test(server.profile.clone(), Some(server.password.clone()), None).unwrap();
        assert!(tested.server.starts_with("PostgreSQL ") || tested.server.starts_with("MySQL "), "{}", tested.server);
        assert_eq!(service.test(server.profile.clone(), None, None).unwrap_err().code, "password_required");
    }
}

#[test]
fn mysql_decodes_common_types() {
    let Some(server) = mysql_server() else { return };
    let result = server
        .direct(
            "select 42, 18446744073709551615, cast(12345.6789 as decimal(12,4)), 'héllo', null, date '2026-11-21',
                    timestamp '2026-11-21 13:05:09', time '07:08:09', json_object('a', 1), x'00ff', cast(0.1 as float), true, balance
             from customers where id = 1",
        )
        .unwrap();
    assert_eq!(
        result.rows[0],
        vec![
            json!(42),
            json!({"t":"number","v":"18446744073709551615"}),
            json!({"t":"number","v":"12345.6789"}),
            json!("héllo"),
            Value::Null,
            json!({"t":"date","v":"2026-11-21"}),
            json!({"t":"datetime","v":"2026-11-21 13:05:09"}),
            json!({"t":"time","v":"07:08:09"}),
            json!({"t":"json","v":"{\"a\": 1}"}),
            json!({"t":"bytes","v":"00ff","n":2}),
            json!(0.1),
            json!(1),
            json!({"t":"number","v":"12.50"}),
        ]
    );
    // Statements other than SELECT that only read.
    assert!(!server.direct("show tables").unwrap().rows.is_empty());
    assert!(!server.direct("describe customers").unwrap().rows.is_empty());
    assert!(!server.direct("explain select * from customers").unwrap().rows.is_empty());
}

#[test]
fn mysql_refuses_writes_even_for_root() {
    let Some(server) = mysql_server() else { return };
    assert_eq!(server.count("select count(*) from customers"), json!(3));
    let writes = [
        "insert into customers(id, name) values (99, 'Mallory')",
        "update customers set name = 'x'",
        "delete from customers",
        "create table made(a int)",
        "drop table customers",
        "truncate table customers",
        "alter table customers add column extra int",
        "create index made_index on customers(name)",
        "replace into customers(id, name) values (1, 'x')",
        "select write_customer(96)",
        "call write_customer_procedure(94)",
        "select 1; delete from customers",
        // A procedure that commits and switches its session to read-write
        // would get past the read-only transaction; it is never executed,
        // because the server reports that CALL returns no rows.
        "call commit_then_write(93)",
        "select 1 into outfile '/var/lib/mysql-files/notation-test-out'",
        "do sleep(0)",
        "set session transaction read write",
    ];
    for sql in writes {
        let error = server.direct(sql).err().unwrap_or_else(|| panic!("{sql} ran"));
        assert!(matches!(error.code, "refused" | "query"), "{sql}: {error:?}");
    }
    assert_eq!(server.count("select count(*) from customers"), json!(3));
    assert_eq!(server.count("select count(*) from information_schema.tables where table_name = 'made'"), json!(0));
    assert_eq!(server.count("select name from customers where id = 1"), json!("Ada"));
    let state = tempfile::tempdir().unwrap();
    let service = server.service(state.path());
    assert_eq!(service.run(request("server", "delete from customers")).unwrap_err().code, "refused");
    let mut run = request("server", "select name from customers where id = :id and name <> :other and balance > :floor");
    run.parameters = BTreeMap::from([("id".into(), json!(2)), ("other".into(), json!("x'; drop table customers; --")), ("floor".into(), json!(-10.5))]);
    assert_eq!(service.run(run).unwrap().rows, vec![vec![json!("Grace")]]);
    assert_eq!(server.count("select count(*) from customers"), json!(3));
}

const SLOW_MYSQL: &str = "select /* notation-cancel-test */ count(*) from numbers a, numbers b, numbers c where a.n + b.n + c.n < 0";

#[test]
fn mysql_limits_rows_times_out_and_cancels_on_the_server() {
    let Some(server) = mysql_server() else { return };
    let limited = server.with(|profile| profile.row_limit = 100).direct("select a.n from numbers a, numbers b").unwrap();
    assert_eq!((limited.rows.len(), limited.truncated), (100, Some("rows")));
    let started = Instant::now();
    let error = server.with(|profile| profile.timeout_seconds = 1).direct(SLOW_MYSQL).unwrap_err();
    assert_eq!(error.code, "timeout", "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(6), "{:?}", started.elapsed());
    let cancel = Arc::new(Cancel::default());
    let worker = {
        let (profile, password, cancel) = (server.profile.clone(), server.password.clone(), cancel.clone());
        std::thread::spawn(move || raw(&profile, Some(&password), SLOW_MYSQL, Vec::new(), cancel).map(|_| ()))
    };
    let running = "select count(*) from information_schema.processlist where info like '%notation-cancel-test%' and info not like '%processlist%'";
    let started = Instant::now();
    while server.count(running) != json!(1) {
        assert!(started.elapsed() < Duration::from_secs(8), "the query never started");
        std::thread::sleep(Duration::from_millis(50));
    }
    let cancelled_at = Instant::now();
    cancel.cancel();
    assert_eq!(worker.join().unwrap().unwrap_err().code, "cancelled");
    assert!(cancelled_at.elapsed() < Duration::from_secs(6), "{:?}", cancelled_at.elapsed());
    let stopped = Instant::now();
    while server.count(running) != json!(0) {
        assert!(stopped.elapsed() < Duration::from_secs(5), "the query kept running on the server after cancel");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn mysql_tls_modes() {
    let Some(server) = mysql_server() else { return };
    let cipher = "select variable_value from performance_schema.session_status where variable_name = 'Ssl_cipher'";
    assert_eq!(server.count(cipher), json!(""), "disable connects in the clear");
    assert_ne!(server.with(|profile| profile.tls_mode = TlsMode::Require).count(cipher), json!(""));
    assert_ne!(server.with(|profile| profile.tls_mode = TlsMode::Prefer).count(cipher), json!(""));
    // The server's generated certificate is not signed by a public CA.
    let untrusted = server.with(|profile| profile.tls_mode = TlsMode::VerifyFull).direct("select 1").unwrap_err();
    assert_eq!(untrusted.code, "connect", "{untrusted:?}");
}

/// The real OS keychain, only when asked: set
/// `NOTATION_SQL_TEST_REAL_KEYCHAIN` to a throwaway service name such as
/// `notation-test-1a2b`. The entry is removed again. Not run by default so
/// `cargo test` never prompts to unlock a keyring.
#[test]
fn the_real_keychain_stores_moves_and_deletes_a_password() {
    let Ok(service_name) = std::env::var("NOTATION_SQL_TEST_REAL_KEYCHAIN") else { return };
    assert!(service_name.starts_with("notation-test-"), "use an obviously named throwaway service");
    let keychain = Arc::new(secrets::Keychain::new(service_name));
    keychain.availability().expect("the keychain is available");
    let state = tempfile::tempdir().unwrap();
    let service = service(state.path(), Box::new(keychain.clone()));
    assert!(service.list().unwrap().keychain_available);
    service.save(network_profile("analytics", PasswordStorage::Keychain), Some(PASSWORD.into()), None).unwrap();
    assert_eq!(keychain.get("analytics").unwrap().unwrap().expose(), PASSWORD);
    service.save(network_profile("warehouse", PasswordStorage::Keychain), None, Some("analytics".into())).unwrap();
    assert!(keychain.get("analytics").unwrap().is_none());
    assert_eq!(keychain.get("warehouse").unwrap().unwrap().expose(), PASSWORD);
    assert!(!contains(&state_bytes(state.path()), PASSWORD));
    service.delete("warehouse").unwrap();
    assert!(keychain.get("warehouse").unwrap().is_none(), "deleting the profile deletes its keychain entry");
    keychain.delete("warehouse").unwrap();
}
