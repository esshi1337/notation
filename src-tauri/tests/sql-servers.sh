#!/usr/bin/env bash
# Throwaway Postgres and MySQL servers for the SQL block integration tests.
#
#   tests/sql-servers.sh start   # start, seed, write <dir>/env
#   . <dir>/env && cargo test --lib sql
#   tests/sql-servers.sh stop    # remove the containers and their data
#
# Containers listen on 127.0.0.1 only, on random high ports, with random
# passwords, and keep their data under the directory below. Needs podman or
# docker, and openssl for the test certificate authority.
set -euo pipefail

dir="${NOTATION_SQL_TEST_DIR:-${TMPDIR:-/tmp}/notation-sql-servers}"
engine="${NOTATION_SQL_TEST_ENGINE:-$(command -v podman || command -v docker)}"
pg=notation-sqltest-postgres
my=notation-sqltest-mysql

stop() {
  "$engine" rm -f -v "$pg" "$my" >/dev/null 2>&1 || true
  if [ -d "$dir" ]; then
    # Rootless containers own their data through a user namespace.
    rm -rf "$dir" 2>/dev/null || "$engine" unshare rm -rf "$dir"
  fi
}

port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
secret() { head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20; }

start() {
  stop
  mkdir -p "$dir/certs" "$dir/pgdata" "$dir/mysqldata" "$dir/pginit"
  chmod 700 "$dir"
  local pg_port my_port pg_pass my_pass
  pg_port=$(port); my_port=$(port); pg_pass=$(secret); my_pass=$(secret)

  # A certificate authority and a server certificate for "localhost".
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Notation test CA" \
    -keyout "$dir/certs/ca.key" -out "$dir/certs/ca.pem" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
    -keyout "$dir/certs/server.key" -out "$dir/certs/server.csr" 2>/dev/null
  printf 'subjectAltName=DNS:localhost\n' > "$dir/certs/san.cnf"
  openssl x509 -req -in "$dir/certs/server.csr" -CA "$dir/certs/ca.pem" -CAkey "$dir/certs/ca.key" \
    -CAcreateserial -days 2 -extfile "$dir/certs/san.cnf" -out "$dir/certs/server.pem" 2>/dev/null
  chmod 644 "$dir/certs/server.key"

  # Postgres wants its key owned by the server user: copy it in at init.
  cat > "$dir/pginit/10-tls.sh" <<'INIT'
#!/bin/sh
set -e
cp /certs/server.pem "$PGDATA/server.crt"
cp /certs/server.key "$PGDATA/server.key"
chmod 600 "$PGDATA/server.key"
cat >> "$PGDATA/postgresql.conf" <<CONF
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
CONF
INIT
  chmod 755 "$dir/pginit/10-tls.sh"

  "$engine" run -d --name "$pg" -p "127.0.0.1:$pg_port:5432" \
    -e POSTGRES_PASSWORD="$pg_pass" -e POSTGRES_DB=notation_test \
    -v "$dir/pgdata:/var/lib/postgresql/data:Z" -v "$dir/certs:/certs:ro,Z" \
    -v "$dir/pginit:/docker-entrypoint-initdb.d:ro,Z" \
    docker.io/library/postgres:17 >/dev/null
  "$engine" run -d --name "$my" -p "127.0.0.1:$my_port:3306" \
    -e MYSQL_ROOT_PASSWORD="$my_pass" -e MYSQL_DATABASE=notation_test \
    -v "$dir/mysqldata:/var/lib/mysql:Z" \
    docker.io/library/mysql:8.4 >/dev/null

  echo "Waiting for Postgres…" >&2
  for _ in $(seq 120); do
    if "$engine" exec "$pg" sh -c 'pg_isready -q -h 127.0.0.1 -U postgres && psql -U postgres -d notation_test -h 127.0.0.1 -c "select 1" >/dev/null 2>&1' 2>/dev/null; then break; fi
    sleep 1
  done
  "$engine" exec -i "$pg" psql -q -v ON_ERROR_STOP=1 -U postgres -d notation_test >/dev/null <<'SQL'
create table customers(id int primary key, name text not null, balance numeric(12,2), created_at timestamp default '2024-01-01', active boolean default true);
insert into customers(id, name, balance) values (1, 'Ada', 12.50), (2, 'Grace', -3.00), (3, 'Linus', 1000000.00);
create sequence customers_seq;
select nextval('customers_seq');
create function write_customer(i int) returns int language plpgsql as $$ begin insert into customers(id, name) values (i, 'function'); return i; end $$;
create procedure write_customer_procedure(i int) language plpgsql as $$ begin insert into customers(id, name) values (i, 'procedure'); end $$;
SQL

  echo "Waiting for MySQL…" >&2
  for _ in $(seq 180); do
    if "$engine" exec -e MYSQL_PWD="$my_pass" "$my" mysql -h 127.0.0.1 -uroot notation_test -e 'select 1' >/dev/null 2>&1; then break; fi
    sleep 1
  done
  "$engine" exec -i -e MYSQL_PWD="$my_pass" "$my" mysql -h 127.0.0.1 -uroot notation_test <<'SQL'
create table customers(id int primary key, name varchar(100) not null, balance decimal(12,2), created_at datetime default '2024-01-01', active boolean default true);
insert into customers(id, name, balance) values (1, 'Ada', 12.50), (2, 'Grace', -3.00), (3, 'Linus', 1000000.00);
create table numbers(n int primary key);
set session cte_max_recursion_depth = 5000;
set global log_bin_trust_function_creators = 1;
insert into numbers with recursive c(n) as (select 1 union all select n + 1 from c where n < 2000) select n from c;
delimiter //
create function write_customer(i int) returns int modifies sql data begin insert into customers(id, name) values (i, 'function'); return i; end//
create procedure write_customer_procedure(i int) begin insert into customers(id, name) values (i, 'procedure'); end//
create procedure commit_then_write(i int) begin commit; set session transaction read write; insert into customers(id, name) values (i, 'committed'); end//
delimiter ;
SQL

  cat > "$dir/env" <<ENV
export NOTATION_SQL_TEST_POSTGRES='127.0.0.1:$pg_port:postgres:$pg_pass:notation_test'
export NOTATION_SQL_TEST_MYSQL='127.0.0.1:$my_port:root:$my_pass:notation_test'
export NOTATION_SQL_TEST_CA='$dir/certs/ca.pem'
ENV
  chmod 600 "$dir/env"
  echo "Servers are ready. Run: . $dir/env && cargo test --lib sql" >&2
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
