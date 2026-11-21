//! A disposable index of selected workspace files. No scanner writes to source files.
use crate::storage::{clear_cache, Database, MAX_CONTENT};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use regex::Regex;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

const MAX_FILES: usize = 10_000;
const MAX_TOTAL: usize = 64 * 1024 * 1024;
const MAX_ERRORS: usize = 100;

#[derive(Debug, Default, Serialize)]
pub struct IndexReport {
    pub files: usize,
    pub indexed: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}
#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub path: String,
    pub name: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
}
#[derive(Debug, Serialize)]
pub struct Task {
    pub path: String,
    pub line: usize,
    pub text: String,
    pub checked: bool,
}
#[derive(Debug, Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}
#[derive(Debug, Serialize)]
pub struct Backlink {
    pub path: String,
    pub line: usize,
    pub text: String,
}
#[derive(Default)]
struct Metadata {
    frontmatter: crate::frontmatter::Frontmatter,
    headings: Vec<crate::wiki::Heading>,
    blocks: Vec<crate::wiki::BlockReference>,
    title: String,
    links: Vec<(usize, String, String, bool)>,
    tags: Vec<(usize, String)>,
    tasks: Vec<(usize, String, bool)>,
}
struct ResolvedLink<'a> {
    line: usize,
    text: &'a str,
    display: String,
    wiki: bool,
    resolved: Option<String>,
    status: &'static str,
    candidates: String,
    heading: Option<String>,
    alias: Option<String>,
}
struct IndexedFile {
    path: PathBuf,
    content: String,
    metadata: Metadata,
}

impl Database {
    pub fn index_workspace(&self) -> Result<IndexReport, String> {
        let (scope, revision) = self.workspace_snapshot()?;
        let root = scope.link_root();
        if scope
            .legacy_root
            .as_ref()
            .is_some_and(|root| !Path::new(root).is_dir())
        {
            return Err("Workspace directory is unavailable. Existing index was kept.".into());
        }
        let mut report = IndexReport::default();
        let mut files = Vec::new();
        let mut total = 0;
        if let Some(legacy_root) = &scope.legacy_root {
            let legacy_root = Path::new(legacy_root);
            scan(
                legacy_root,
                legacy_root,
                0,
                &mut files,
                &mut total,
                &mut report,
            );
        }
        {
            let mut scanned: HashSet<PathBuf> =
                files.iter().map(|file| file.path.clone()).collect();
            for path in &scope.files {
                if scanned.contains(Path::new(path)) {
                    continue;
                }
                if report.files >= MAX_FILES {
                    report_error(&mut report, "Workspace exceeds 10,000 file indexing limit.");
                    break;
                }
                if !matches!(
                    Path::new(path)
                        .extension()
                        .and_then(|s| s.to_str())
                        .map(str::to_ascii_lowercase)
                        .as_deref(),
                    Some("md" | "markdown" | "mmd")
                ) {
                    continue;
                }
                report.files += 1;
                let content = crate::explorer::read_scoped_file(&scope, path).map(|d| d.content);
                match content {
                    Ok(content) if total + content.len() <= MAX_TOTAL => {
                        total += content.len();
                        let metadata = if Path::new(path)
                            .extension()
                            .is_some_and(|s| s.eq_ignore_ascii_case("mmd"))
                        {
                            Metadata::default()
                        } else {
                            parse_metadata(&content)
                        };
                        if let Some(error) = &metadata.frontmatter.error {
                            report_error(&mut report, format!("{path}: YAML: {}", error.message));
                        }
                        scanned.insert(PathBuf::from(path));
                        files.push(IndexedFile {
                            path: PathBuf::from(path),
                            content,
                            metadata,
                        });
                        report.indexed += 1;
                    }
                    Ok(_) => {
                        report.skipped += 1;
                        report_error(
                            &mut report,
                            format!("{path}: Workspace exceeds 64 MiB indexing limit."),
                        );
                    }
                    Err(error) => {
                        report.skipped += 1;
                        report_error(&mut report, format!("{path}: {error}"));
                    }
                }
            }
        }
        let paths: HashSet<PathBuf> = files.iter().map(|file| file.path.clone()).collect();
        let notes = files
            .iter()
            .map(|file| crate::wiki::Candidate {
                path: file.path.to_string_lossy().into(),
                name: file
                    .path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into(),
                title: file.metadata.title.clone(),
                relative_path: String::new(),
                link: String::new(),
                aliases: crate::frontmatter::string_list(
                    file.metadata.frontmatter.properties.get("aliases"),
                ),
                headings: file.metadata.headings.clone(),
                blocks: file.metadata.blocks.clone(),
            })
            .collect::<Vec<_>>();
        // Resolve every link before taking the database lock: resolution only
        // needs the scanned note set, and other commands wait on that lock.
        let lookup = crate::wiki::NoteLookup::new(&notes);
        let mut limits = ReferenceLimits::default();
        let mut resolved_files = Vec::with_capacity(files.len());
        for file in &files {
            resolved_files.push(resolve_references(
                file,
                &root,
                &lookup,
                &paths,
                &mut limits,
                &mut report,
            )?);
        }
        // Later saves may update single notes in place only when this rebuild
        // indexed everything: nothing skipped, no limit reached, and no error
        // other than the per-note YAML ones (one for each affected note).
        let yaml_errors = files
            .iter()
            .filter(|file| file.metadata.frontmatter.error.is_some())
            .count();
        let complete = report.skipped == 0
            && report.errors.len() < MAX_ERRORS
            && report.errors.len() == yaml_errors;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        crate::workspace_catalog::validate_index_snapshot(&tx, &scope, revision)?;
        clear_cache(&tx)?;
        for (file, references) in files.iter().zip(&resolved_files) {
            insert_file(&tx, file, references, false)?;
        }
        if complete {
            let baseline = Baseline {
                workspace: scope.id.clone(),
                revision,
                files: report.files,
                indexed: report.indexed,
                errors: report.errors.clone(),
            };
            tx.execute(
                "INSERT OR REPLACE INTO app_meta(key,value) VALUES(?1,?2)",
                params![
                    crate::storage::INDEX_BASELINE_KEY,
                    serde_json::to_string(&baseline).map_err(|error| error.to_string())?
                ],
            )
            .map_err(|error| error.to_string())?;
        }
        tx.commit().map_err(|error| error.to_string())?;
        Ok(report)
    }
    /// Update the index for one saved note without rescanning the workspace.
    ///
    /// Wiki-link resolution depends only on the set of note paths, names and
    /// aliases. When a save changes none of those, only this note's rows can
    /// differ from a full rebuild, so they are replaced in one transaction.
    /// Returns `None` whenever that cannot be shown; the caller then runs the
    /// full rebuild, exactly as every save did before.
    pub fn index_saved_file(
        &self,
        path: &str,
        content: &str,
    ) -> Result<Option<IndexReport>, String> {
        if content.len() > MAX_CONTENT {
            return Ok(None);
        }
        let (scope, revision) = self.workspace_snapshot()?;
        let root = scope.link_root();
        let file = IndexedFile {
            path: PathBuf::from(path),
            content: content.to_string(),
            metadata: metadata_for(Path::new(path), content),
        };
        if file.metadata.frontmatter.error.is_some() {
            return Ok(None);
        }
        let aliases =
            crate::frontmatter::string_list(file.metadata.frontmatter.properties.get("aliases"));
        let mut connection = self.lock()?;
        let tx = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        if crate::workspace_catalog::validate_index_snapshot(&tx, &scope, revision).is_err() {
            return Ok(None);
        }
        // The last full rebuild must have been complete for this workspace
        // and membership revision.
        let baseline: Option<String> = tx
            .query_row(
                "SELECT value FROM app_meta WHERE key=?1",
                [crate::storage::INDEX_BASELINE_KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(baseline) = baseline
            .and_then(|value| serde_json::from_str::<Baseline>(&value).ok())
            .filter(|baseline| baseline.workspace == scope.id && baseline.revision == revision)
        else {
            return Ok(None);
        };
        // The note must already be indexed, without a YAML error, under the
        // same aliases: then no other note's links can resolve differently.
        let previous: Option<(i64, String)> = tx
            .query_row(
                "SELECT octet_length(f.content), m.json FROM cache_files f JOIN cache_frontmatter m ON m.path=f.path WHERE f.path=?1",
                [path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((previous_size, previous_frontmatter)) = previous else {
            return Ok(None);
        };
        let Ok(previous_frontmatter) =
            serde_json::from_str::<crate::frontmatter::Frontmatter>(&previous_frontmatter)
        else {
            return Ok(None);
        };
        if previous_frontmatter.error.is_some()
            || crate::frontmatter::string_list(previous_frontmatter.properties.get("aliases"))
                != aliases
        {
            return Ok(None);
        }
        // Stay strictly inside the rebuild's limits, so a rebuild would not
        // have skipped or truncated anything either.
        let count = |sql: &str, parameter: Option<&str>| -> Result<i64, String> {
            match parameter {
                Some(parameter) => tx.query_row(sql, [parameter], |row| row.get(0)),
                None => tx.query_row(sql, [], |row| row.get(0)),
            }
            .map_err(|error| error.to_string())
        };
        let total = count(
            "SELECT COALESCE(sum(octet_length(content)),0) FROM cache_files",
            None,
        )?;
        if total - previous_size + content.len() as i64 >= MAX_TOTAL as i64 {
            return Ok(None);
        }
        // Rebuild the lookup the full index used: every indexed note in scan
        // order, with its aliases.
        let mut alias_rows: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        {
            let mut statement = tx
                .prepare("SELECT path,json_value FROM cache_properties WHERE key='aliases'")
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|error| error.to_string())?;
            for row in rows {
                let (note, value) = row.map_err(|error| error.to_string())?;
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&value) else {
                    return Ok(None);
                };
                alias_rows.insert(note, crate::frontmatter::string_list(Some(&value)));
            }
        }
        let notes = {
            let mut statement = tx
                .prepare("SELECT path,name FROM cache_files ORDER BY rowid")
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|error| error.to_string())?;
            let mut notes = Vec::new();
            for row in rows {
                let (note, name) = row.map_err(|error| error.to_string())?;
                let aliases = alias_rows.remove(&note).unwrap_or_default();
                notes.push(crate::wiki::Candidate {
                    path: note,
                    name,
                    title: String::new(),
                    relative_path: String::new(),
                    link: String::new(),
                    aliases,
                    headings: vec![],
                    blocks: vec![],
                });
            }
            notes
        };
        let paths: HashSet<PathBuf> = notes.iter().map(|note| PathBuf::from(&note.path)).collect();
        let lookup = crate::wiki::NoteLookup::new(&notes);
        let mut limits = ReferenceLimits::default();
        let mut report = IndexReport::default();
        let references =
            resolve_references(&file, &root, &lookup, &paths, &mut limits, &mut report)?;
        let blocks = count("SELECT count(*) FROM cache_blocks", None)?
            - count("SELECT count(*) FROM cache_blocks WHERE path=?1", Some(path))?
            + references.blocks as i64;
        let links = count("SELECT count(*) FROM cache_graph_links", None)?
            - count(
                "SELECT count(*) FROM cache_graph_links WHERE source_path=?1",
                Some(path),
            )?
            + references.links.len() as i64;
        if blocks >= REFERENCE_LIMIT as i64 || links >= REFERENCE_LIMIT as i64 {
            return Ok(None);
        }
        for statement in [
            "DELETE FROM cache_fts WHERE rowid=(SELECT rowid FROM cache_files WHERE path=?1)",
            "DELETE FROM cache_properties WHERE path=?1",
            "DELETE FROM cache_headings WHERE path=?1",
            "DELETE FROM cache_blocks WHERE path=?1",
            "DELETE FROM cache_graph_links WHERE source_path=?1",
            "DELETE FROM cache_links WHERE source_path=?1",
            "DELETE FROM cache_tags WHERE path=?1",
            "DELETE FROM cache_tasks WHERE path=?1",
        ] {
            tx.execute(statement, [path])
                .map_err(|error| error.to_string())?;
        }
        insert_file(&tx, &file, &references, true)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(Some(IndexReport {
            files: baseline.files,
            indexed: baseline.indexed,
            skipped: 0,
            errors: baseline.errors,
        }))
    }
    pub fn search_workspace(
        &self,
        query: &str,
        limit: Option<usize>,
    ) -> Result<Vec<SearchResult>, String> {
        if query.len() > 512 {
            return Err("Search query exceeds the 512 character limit.".into());
        }
        let limit = limit.unwrap_or(100).clamp(1, 500) as i64;
        let connection = self.lock()?;
        if query.trim().is_empty() {
            let mut statement=connection.prepare("SELECT path,name,title,substr(content,1,160) FROM cache_files ORDER BY title COLLATE NOCASE,path LIMIT ?1").map_err(|error|error.to_string())?;
            let rows = statement
                .query_map([limit], |row| {
                    Ok(SearchResult {
                        path: row.get(0)?,
                        name: row.get(1)?,
                        title: row.get(2)?,
                        snippet: row.get(3)?,
                        score: 0.0,
                    })
                })
                .map_err(|error| error.to_string())?;
            return rows
                .collect::<Result<_, _>>()
                .map_err(|error| error.to_string());
        }
        let query = query
            .split_whitespace()
            .filter(|term| term.chars().any(char::is_alphanumeric))
            .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        if query.is_empty() {
            return Ok(vec![]);
        }
        let mut statement=connection.prepare("SELECT f.path,f.name,f.title,snippet(cache_fts,2,'','','…',24),bm25(cache_fts) FROM cache_fts JOIN cache_files f ON f.path=cache_fts.path WHERE cache_fts MATCH ?1 ORDER BY bm25(cache_fts),f.path LIMIT ?2").map_err(|error|error.to_string())?;
        let rows = statement
            .query_map(params![query, limit], |row| {
                Ok(SearchResult {
                    path: row.get(0)?,
                    name: row.get(1)?,
                    title: row.get(2)?,
                    snippet: row.get(3)?,
                    score: row.get(4)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|error| error.to_string())
    }
    pub fn get_tasks(&self, checked: Option<bool>) -> Result<Vec<Task>, String> {
        let connection = self.lock()?;
        let mut statement=connection.prepare("SELECT path,line,text,checked FROM cache_tasks WHERE (?1 IS NULL OR checked=?1) ORDER BY path,line LIMIT 2000").map_err(|error|error.to_string())?;
        let rows = statement
            .query_map([checked], |row| {
                Ok(Task {
                    path: row.get(0)?,
                    line: row.get::<_, i64>(1)? as usize,
                    text: row.get(2)?,
                    checked: row.get(3)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|error| error.to_string())
    }
    pub fn get_tags(&self) -> Result<Vec<TagCount>, String> {
        let connection = self.lock()?;
        let mut statement=connection.prepare("SELECT tag,count(DISTINCT path) FROM cache_tags GROUP BY tag ORDER BY tag COLLATE NOCASE LIMIT 2000").map_err(|error|error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(TagCount {
                    tag: row.get(0)?,
                    count: row.get::<_, i64>(1)? as usize,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|error| error.to_string())
    }
    pub fn get_backlinks(&self, path: &str) -> Result<Vec<Backlink>, String> {
        let scope = self.active_workspace()?;
        let path = scope.resolve(path)?;
        let connection = self.lock()?;
        let mut statement=connection.prepare("SELECT DISTINCT source_path,line,text FROM cache_links WHERE target_path=?1 ORDER BY source_path,line LIMIT 2000").map_err(|error|error.to_string())?;
        let rows = statement
            .query_map([path.to_string_lossy()], |row| {
                Ok(Backlink {
                    path: row.get(0)?,
                    line: row.get::<_, i64>(1)? as usize,
                    text: row.get(2)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|error| error.to_string())
    }
}
const REFERENCE_LIMIT: usize = 100_000;
/// What a complete full rebuild leaves behind for single-note updates.
#[derive(Serialize, serde::Deserialize)]
struct Baseline {
    workspace: String,
    revision: i64,
    files: usize,
    indexed: usize,
    errors: Vec<String>,
}
#[derive(Default)]
struct ReferenceLimits {
    blocks: usize,
    links: usize,
}
struct FileReferences<'a> {
    /// Leading block references kept under the workspace limit.
    blocks: usize,
    links: Vec<ResolvedLink<'a>>,
}
fn metadata_for(path: &Path, content: &str) -> Metadata {
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mmd"))
    {
        Metadata::default()
    } else {
        parse_metadata(content)
    }
}
fn resolve_references<'a>(
    file: &'a IndexedFile,
    root: &Path,
    lookup: &crate::wiki::NoteLookup<'_>,
    paths: &HashSet<PathBuf>,
    limits: &mut ReferenceLimits,
    report: &mut IndexReport,
) -> Result<FileReferences<'a>, String> {
    let mut blocks = 0;
    for _ in &file.metadata.blocks {
        if limits.blocks >= REFERENCE_LIMIT {
            report_error(
                report,
                "Workspace block references exceeded the 100,000 reference limit.",
            );
            break;
        }
        limits.blocks += 1;
        blocks += 1;
    }
    let mut links = Vec::new();
    for (line, text, target, wiki) in &file.metadata.links {
        if limits.links >= REFERENCE_LIMIT {
            report_error(
                report,
                "Workspace links exceeded the 100,000 reference limit.",
            );
            break;
        }
        let Some((display, heading, alias)) =
            crate::wiki::scoped_link(root, &file.path, target, *wiki)
        else {
            continue;
        };
        limits.links += 1;
        let matches = if *wiki {
            lookup.matches(root, &file.path, target)
        } else if display.is_empty() {
            vec![file.path.clone()]
        } else {
            link_target(root, &file.path, target, false, paths)
                .into_iter()
                .collect::<Vec<_>>()
        };
        let resolved = (matches.len() == 1).then(|| matches[0].to_string_lossy().into_owned());
        let status = match matches.len() {
            0 => "missing",
            1 => "resolved",
            _ => "ambiguous",
        };
        let candidates = if matches.len() > 1 {
            matches
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        } else {
            vec![]
        };
        links.push(ResolvedLink {
            line: *line,
            text,
            display,
            wiki: *wiki,
            resolved,
            status,
            candidates: serde_json::to_string(&candidates).map_err(|error| error.to_string())?,
            heading,
            alias,
        });
    }
    Ok(FileReferences { blocks, links })
}
/// Write one note's rows. `existing` keeps the note's `cache_files` and
/// `cache_frontmatter` rows in place (and so their scan order) and expects
/// the caller to have removed its other rows.
fn insert_file(
    tx: &rusqlite::Transaction<'_>,
    file: &IndexedFile,
    references: &FileReferences<'_>,
    existing: bool,
) -> Result<(), String> {
    let path = file.path.to_string_lossy();
    let name = file.path.file_name().unwrap_or_default().to_string_lossy();
    let title = if file.metadata.title.is_empty() {
        name.as_ref()
    } else {
        &file.metadata.title
    };
    let frontmatter =
        serde_json::to_string(&file.metadata.frontmatter).map_err(|error| error.to_string())?;
    if existing {
        tx.execute(
            "UPDATE cache_files SET name=?2,title=?3,content=?4 WHERE path=?1",
            params![path, name, title, file.content],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "UPDATE cache_frontmatter SET json=?2 WHERE path=?1",
            params![path, frontmatter],
        )
        .map_err(|error| error.to_string())?;
    } else {
        tx.execute(
            "INSERT INTO cache_files(path,name,title,content) VALUES(?1,?2,?3,?4)",
            params![path, name, title, file.content],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO cache_frontmatter(path,json) VALUES(?1,?2)",
            params![path, frontmatter],
        )
        .map_err(|error| error.to_string())?;
    }
    // The full-text row shares the note's rowid, so a later single-note
    // update can find it without scanning the full-text table.
    tx.execute(
        "INSERT INTO cache_fts(rowid,path,title,body) VALUES((SELECT rowid FROM cache_files WHERE path=?1),?1,?2,?3)",
        params![path, title, file.content],
    )
    .map_err(|error| error.to_string())?;
    if let Some(properties) = file.metadata.frontmatter.properties.as_object() {
        for (key, value) in properties {
            let kind = match value {
                serde_json::Value::Null => "null",
                serde_json::Value::Bool(_) => "boolean",
                serde_json::Value::Number(_) => "number",
                serde_json::Value::String(_) => "string",
                serde_json::Value::Array(_) => "array",
                serde_json::Value::Object(_) => "object",
            };
            tx.execute(
                "INSERT INTO cache_properties(path,key,kind,json_value) VALUES(?1,?2,?3,?4)",
                params![path, key, kind, value.to_string()],
            )
            .map_err(|error| error.to_string())?;
        }
    }
    for heading in &file.metadata.headings {
        tx.execute(
            "INSERT INTO cache_headings(path,text,line,level) VALUES(?1,?2,?3,?4)",
            params![
                path,
                heading.text,
                heading.line as i64,
                heading.level as i64
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    for block in file.metadata.blocks.iter().take(references.blocks) {
        tx.execute(
            "INSERT INTO cache_blocks(path,id,line) VALUES(?1,?2,?3)",
            params![path, block.id, block.line as i64],
        )
        .map_err(|error| error.to_string())?;
    }
    for link in &references.links {
        tx.execute("INSERT INTO cache_graph_links(source_path,line,raw_target,kind,target_path,status,candidates_json,heading,alias) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![path,link.line as i64,link.display,if link.wiki{"wiki"}else{"markdown"},link.resolved,link.status,link.candidates,link.heading,link.alias]).map_err(|error|error.to_string())?;
        if let Some(target) = &link.resolved {
            tx.execute(
                "INSERT INTO cache_links(source_path,line,text,target_path) VALUES(?1,?2,?3,?4)",
                params![path, link.line as i64, link.text, target],
            )
            .map_err(|error| error.to_string())?;
        }
    }
    for (line, tag) in &file.metadata.tags {
        tx.execute(
            "INSERT INTO cache_tags(path,line,tag) VALUES(?1,?2,?3)",
            params![path, *line as i64, tag],
        )
        .map_err(|error| error.to_string())?;
    }
    for (line, text, checked) in &file.metadata.tasks {
        tx.execute(
            "INSERT INTO cache_tasks(path,line,text,checked) VALUES(?1,?2,?3,?4)",
            params![path, *line as i64, text, checked],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}
fn report_error(report: &mut IndexReport, error: impl Into<String>) {
    if report.errors.len() < MAX_ERRORS {
        report.errors.push(error.into());
    }
}
fn scan(
    root: &Path,
    path: &Path,
    depth: usize,
    files: &mut Vec<IndexedFile>,
    total: &mut usize,
    report: &mut IndexReport,
) {
    if depth > 64 {
        report.skipped += 1;
        report_error(
            report,
            format!("Directory nesting exceeds 64 levels: {}", path.display()),
        );
        return;
    }
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) => {
            report_error(
                report,
                format!("Could not read {}: {error}", path.display()),
            );
            return;
        }
    };
    for entry in entries {
        if report.files >= MAX_FILES || *total >= MAX_TOTAL {
            report_error(
                report,
                "Workspace indexing stopped at its 10,000 file / 64 MiB content limit.",
            );
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                report_error(report, error.to_string());
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = match entry.file_type() {
            Ok(kind) => kind,
            Err(error) => {
                report_error(report, error.to_string());
                continue;
            }
        };
        if kind.is_symlink() {
            report.skipped += 1;
            continue;
        }
        if kind.is_dir() {
            if name.starts_with('.')
                || matches!(
                    name.as_str(),
                    "node_modules"
                        | "target"
                        | "dist"
                        | "build"
                        | "vendor"
                        | "coverage"
                        | "__pycache__"
                )
            {
                report.skipped += 1;
                continue;
            }
            scan(root, &entry.path(), depth + 1, files, total, report);
            continue;
        }
        if !kind.is_file()
            || name.starts_with('.')
            || !matches!(
                entry
                    .path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("md" | "markdown" | "mmd")
            )
        {
            continue;
        }
        report.files += 1;
        let file_path = match entry.path().canonicalize() {
            Ok(path) if path.starts_with(root) => path,
            _ => {
                report.skipped += 1;
                report_error(
                    report,
                    format!(
                        "Skipped unavailable or escaped path: {}",
                        entry.path().display()
                    ),
                );
                continue;
            }
        };
        let file = match crate::explorer::open_regular(&file_path) {
            Ok(file) => file,
            Err(error) => {
                report.skipped += 1;
                report_error(
                    report,
                    format!("Could not read {}: {error}", file_path.display()),
                );
                continue;
            }
        };
        let mut bytes = Vec::new();
        if let Err(error) = file.take((MAX_CONTENT + 1) as u64).read_to_end(&mut bytes) {
            report.skipped += 1;
            report_error(
                report,
                format!("Could not read {}: {error}", file_path.display()),
            );
            continue;
        }
        if bytes.len() > MAX_CONTENT || *total + bytes.len() > MAX_TOTAL {
            report.skipped += 1;
            report_error(
                report,
                format!("Skipped oversized file: {}", file_path.display()),
            );
            continue;
        }
        let content = match String::from_utf8(bytes) {
            Ok(content) => content,
            Err(_) => {
                report.skipped += 1;
                report_error(
                    report,
                    format!("Skipped non-UTF-8 file: {}", file_path.display()),
                );
                continue;
            }
        };
        *total += content.len();
        let metadata = if file_path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("mmd"))
        {
            Metadata::default()
        } else {
            parse_metadata(&content)
        };
        if let Some(error) = &metadata.frontmatter.error {
            report_error(
                report,
                format!(
                    "{}:{}: YAML: {}",
                    file_path.display(),
                    error.line.unwrap_or(1),
                    error.message
                ),
            );
        }
        files.push(IndexedFile {
            path: file_path,
            content,
            metadata,
        });
        report.indexed += 1;
    }
}
// Compiling these per parsed file cost about 0.5 ms each (the tag pattern
// builds Unicode classes), which dominated indexing of large workspaces.
static TAGS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[^\p{L}\p{N}_/])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)").unwrap()
});
// Keep marker/quote/list syntax in sync with the editor's task recognizer.
static TASKS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]+)?\[([ xX]?)\](?:[ \t]+(.*))?$")
        .unwrap()
});
static BLOCKS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[ \t])\^([A-Za-z0-9][A-Za-z0-9-]*)[ \t]*$").unwrap());

/// Byte offsets of every `\n`, so a line number is a binary search instead
/// of a rescan from the start of the note for each heading, link and block.
fn newline_offsets(source: &str) -> Vec<usize> {
    source
        .bytes()
        .enumerate()
        .filter_map(|(index, byte)| (byte == b'\n').then_some(index))
        .collect()
}
/// One-based line of `offset`: one more than the newlines before it.
fn line_at(newlines: &[usize], offset: usize) -> usize {
    newlines.partition_point(|&newline| newline < offset) + 1
}
fn line_text(source: &str, offset: usize) -> String {
    let start = source[..offset].rfind('\n').map_or(0, |index| index + 1);
    let end = source[offset..]
        .find('\n')
        .map_or(source.len(), |index| offset + index);
    source[start..end].trim().chars().take(500).collect()
}
fn mask(bytes: &mut [u8], range: std::ops::Range<usize>) {
    for byte in &mut bytes[range] {
        if *byte != b'\n' {
            *byte = b' ';
        }
    }
}
fn parse_metadata(source: &str) -> Metadata {
    let mut metadata = Metadata::default();
    let newlines = newline_offsets(source);
    let mut cleaned = source.as_bytes().to_vec();
    metadata.frontmatter = crate::frontmatter::parse(source);
    if metadata.frontmatter.closed {
        mask(&mut cleaned, 0..metadata.frontmatter.byte_end);
        for property in ["tags", "tag"] {
            for tag in
                crate::frontmatter::string_list(metadata.frontmatter.properties.get(property))
            {
                let tag = tag.trim_start_matches('#').to_string();
                if !tag.is_empty() {
                    metadata.tags.push((2, tag));
                }
            }
        }
        if let Some(title) = metadata
            .frontmatter
            .properties
            .get("title")
            .and_then(serde_json::Value::as_str)
        {
            metadata.title = title.trim().to_string();
        }
    }
    let front_clean = String::from_utf8(cleaned.clone()).unwrap();
    let mut code_start = None;
    let mut block_stack = Vec::new();
    let mut block_ranges = Vec::new();
    let mut heading: Option<crate::wiki::Heading> = None;
    let options = Options::ENABLE_TASKLISTS | Options::ENABLE_MATH;
    for (event, range) in Parser::new_ext(&front_clean, options).into_offset_iter() {
        if let Event::Start(tag) = &event {
            if matches!(
                tag,
                Tag::Paragraph
                    | Tag::Heading { .. }
                    | Tag::Item
                    | Tag::BlockQuote(_)
                    | Tag::CodeBlock(_)
                    | Tag::HtmlBlock
            ) {
                block_stack.push((tag.to_end(), range.start));
            }
        }
        if let Event::End(tag) = &event {
            if let Some(index) = block_stack.iter().rposition(|(end, _)| end == tag) {
                let (_, start) = block_stack.remove(index);
                block_ranges.push(start..range.end);
            }
        }
        match event {
            Event::Start(Tag::CodeBlock(_)) => code_start = Some(range.start),
            Event::End(TagEnd::CodeBlock) => {
                if let Some(start) = code_start.take() {
                    mask(&mut cleaned, start..range.end);
                }
            }
            Event::Code(text) => {
                if let Some(heading) = &mut heading {
                    heading.text.push_str(&text);
                }
                mask(&mut cleaned, range);
            }
            Event::InlineMath(_)
            | Event::DisplayMath(_)
            | Event::Html(_)
            | Event::InlineHtml(_) => mask(&mut cleaned, range),
            Event::Start(Tag::Heading { level, .. }) => {
                heading = Some(crate::wiki::Heading {
                    text: String::new(),
                    line: line_at(&newlines, range.start),
                    level: level as usize,
                })
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(mut heading) = heading.take() {
                    heading.text = heading.text.trim().to_string();
                    if metadata.title.is_empty() {
                        metadata.title = heading.text.clone();
                    }
                    metadata.headings.push(heading);
                }
            }
            Event::Text(text) if heading.is_some() => {
                heading.as_mut().unwrap().text.push_str(&text)
            }
            Event::Start(Tag::Link { dest_url, .. }) => metadata.links.push((
                line_at(&newlines, range.start),
                line_text(source, range.start),
                dest_url.to_string(),
                false,
            )),
            _ => (),
        }
    }
    if let Some(start) = code_start {
        mask(&mut cleaned, start..source.len());
    }
    let cleaned = String::from_utf8(cleaned).unwrap();
    for (offset, target) in crate::wiki::spans(&cleaned) {
        metadata.links.push((
            line_at(&newlines, offset),
            line_text(source, offset),
            target,
            true,
        ));
    }
    let (tags, tasks, blocks) = (&*TAGS, &*TASKS, &*BLOCKS);
    let mut line_offset = 0;
    for (line, raw_line) in cleaned.split_inclusive('\n').enumerate() {
        let text = raw_line.trim_end_matches(['\r', '\n']);
        if let Some(block) = blocks.captures(text) {
            let matched = block.get(0).unwrap();
            let marker = line_offset + matched.start() + matched.as_str().find('^').unwrap();
            let marker_end = marker + block[1].len() + 1;
            let own_line = cleaned[line_offset..marker].trim().is_empty();
            let mut candidates = block_ranges
                .iter()
                .filter(|range| {
                    range.start <= marker
                        && range.end >= marker_end
                        && !(own_line && range.start == marker)
                })
                .collect::<Vec<_>>();
            if own_line && candidates.is_empty() {
                candidates = block_ranges
                    .iter()
                    .filter(|range| {
                        range.end <= line_offset && source[range.end..line_offset].trim().is_empty()
                    })
                    .collect();
                candidates.sort_by_key(|range| (std::cmp::Reverse(range.end), range.start));
            } else {
                candidates.sort_by_key(|range| range.end - range.start);
            }
            if let Some(range) = candidates.first() {
                metadata.blocks.push(crate::wiki::BlockReference {
                    id: block[1].to_string(),
                    line: line_at(&newlines, range.start),
                });
            }
        }
        for tag in tags.captures_iter(text) {
            metadata
                .tags
                .push((line + 1, tag[1].trim_end_matches('/').to_string()));
        }
        if let Some(task) = tasks.captures(text) {
            metadata.tasks.push((
                line + 1,
                task.get(2)
                    .map_or("", |label| label.as_str())
                    .trim()
                    .to_string(),
                matches!(&task[1], "x" | "X"),
            ));
        }
        line_offset += raw_line.len();
    }
    metadata.tags.sort();
    metadata.tags.dedup();
    metadata
}
fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => (),
            other => result.push(other.as_os_str()),
        }
    }
    result
}
fn link_target(
    root: &Path,
    source: &Path,
    target: &str,
    wiki: bool,
    files: &HashSet<PathBuf>,
) -> Option<PathBuf> {
    let target = target.split(['#', '?']).next()?.trim();
    if target.is_empty() || target.contains(':') {
        return None;
    }
    let target = percent_encoding::percent_decode_str(target)
        .decode_utf8()
        .ok()?;
    let raw = Path::new(target.as_ref());
    let target = if raw.is_absolute() {
        if wiki {
            root.join(target.trim_start_matches('/'))
        } else {
            raw.to_path_buf()
        }
    } else {
        source.parent()?.join(raw)
    };
    let target = normalize(&target);
    if !target.starts_with(root) {
        return None;
    }
    let mut candidates = vec![target.clone()];
    if target.extension().is_none() {
        for extension in ["md", "markdown", "mmd"] {
            candidates.push(target.with_extension(extension));
        }
    }
    for candidate in candidates {
        if files.contains(&candidate) {
            return Some(candidate);
        }
    }
    if wiki {
        let stem = target.file_stem()?;
        let mut found = files.iter().filter(|path| path.file_stem() == Some(stem));
        let first = found.next()?;
        if found.next().is_none() {
            return Some(first.clone());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_index_matches_a_newline_count_at_every_offset() {
        for source in ["", "one", "\n", "a\nb\n", "a\r\nb\r\n\r\nc", "\n\n\nx\n", "é\nü\n"] {
            let newlines = newline_offsets(source);
            for offset in 0..=source.len() {
                let expected = source.as_bytes()[..offset]
                    .iter()
                    .filter(|byte| **byte == b'\n')
                    .count()
                    + 1;
                assert_eq!(line_at(&newlines, offset), expected, "{source:?} at {offset}");
            }
        }
    }

    #[test]
    fn dense_notes_keep_heading_link_and_block_lines() {
        let mut source = String::from("---\ntitle: Dense\n---\n");
        for index in 0..500 {
            source.push_str(&format!(
                "## Heading {index}\r\n[[note{index}]] and [doc](doc{index}.md) #tag{index} ^block{index}\n\n"
            ));
        }
        let metadata = parse_metadata(&source);
        assert_eq!(metadata.headings.len(), 500);
        assert_eq!(metadata.blocks.len(), 500);
        assert_eq!(metadata.links.len(), 1000);
        for (index, heading) in metadata.headings.iter().enumerate() {
            assert_eq!(heading.line, 4 + index * 3, "heading {index}");
        }
        for (index, block) in metadata.blocks.iter().enumerate() {
            assert_eq!(block.line, 5 + index * 3, "block {index}");
        }
        for (line, _, target, _) in &metadata.links {
            let index: usize = target
                .trim_start_matches("note")
                .trim_start_matches("doc")
                .trim_end_matches(".md")
                .parse()
                .unwrap();
            assert_eq!(*line, 5 + index * 3, "link {target}");
        }
    }
}
