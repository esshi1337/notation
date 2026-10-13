//! A disposable index of selected workspace files. No scanner writes to source files.
use crate::storage::{clear_cache, Database, MAX_CONTENT};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use regex::Regex;
use rusqlite::params;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

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
struct IndexedFile {
    path: PathBuf,
    content: String,
    metadata: Metadata,
}

impl Database {
    pub fn index_workspace(&self) -> Result<IndexReport, String> {
        let selected = self
            .workspace()?
            .ok_or("Choose a workspace directory first.")?;
        let root = PathBuf::from(&selected);
        if !root.is_dir() {
            return Err("Workspace directory is unavailable. Existing index was kept.".into());
        }
        let mut report = IndexReport::default();
        let mut files = Vec::new();
        let mut total = 0;
        scan(&root, &root, 0, &mut files, &mut total, &mut report);
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
        let mut connection = self.lock()?;
        let tx = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let active: String = tx
            .query_row("SELECT path FROM workspaces WHERE id=1", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        if active != selected {
            return Err("Workspace changed during indexing. Refresh the new workspace.".into());
        }
        clear_cache(&tx)?;
        let mut graph_refs = 0;
        let mut block_refs = 0;
        for file in files {
            let path = file.path.to_string_lossy();
            let name = file.path.file_name().unwrap_or_default().to_string_lossy();
            let title = if file.metadata.title.is_empty() {
                name.as_ref()
            } else {
                &file.metadata.title
            };
            tx.execute(
                "INSERT INTO cache_files(path,name,title,content) VALUES(?1,?2,?3,?4)",
                params![path, name, title, file.content],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT INTO cache_fts(path,title,body) VALUES(?1,?2,?3)",
                params![path, title, file.content],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT INTO cache_frontmatter(path,json) VALUES(?1,?2)",
                params![
                    path,
                    serde_json::to_string(&file.metadata.frontmatter)
                        .map_err(|error| error.to_string())?
                ],
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
                    tx.execute("INSERT INTO cache_properties(path,key,kind,json_value) VALUES(?1,?2,?3,?4)",params![path,key,kind,value.to_string()]).map_err(|error|error.to_string())?;
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
            for block in &file.metadata.blocks {
                if block_refs >= 100000 {
                    report_error(
                        &mut report,
                        "Workspace block references exceeded the 100,000 reference limit.",
                    );
                    break;
                }
                block_refs += 1;
                tx.execute(
                    "INSERT INTO cache_blocks(path,id,line) VALUES(?1,?2,?3)",
                    params![path, block.id, block.line as i64],
                )
                .map_err(|error| error.to_string())?;
            }
            for (line, text, target, wiki) in file.metadata.links {
                if graph_refs >= 100000 {
                    report_error(
                        &mut report,
                        "Workspace links exceeded the 100,000 reference limit.",
                    );
                    break;
                }
                let Some((display, heading, alias)) =
                    crate::wiki::scoped_link(&root, &file.path, &target, wiki)
                else {
                    continue;
                };
                graph_refs += 1;
                let matches = if wiki {
                    crate::wiki::indexed_matches(&root, &file.path, &target, &notes)
                } else if display.is_empty() {
                    vec![file.path.clone()]
                } else {
                    link_target(&root, &file.path, &target, false, &paths)
                        .into_iter()
                        .collect::<Vec<_>>()
                };
                let resolved =
                    (matches.len() == 1).then(|| matches[0].to_string_lossy().into_owned());
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
                tx.execute("INSERT INTO cache_graph_links(source_path,line,raw_target,kind,target_path,status,candidates_json,heading,alias) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![path,line as i64,display,if wiki{"wiki"}else{"markdown"},resolved,status,serde_json::to_string(&candidates).map_err(|error|error.to_string())?,heading,alias]).map_err(|error|error.to_string())?;
                if let Some(target) = resolved {
                    tx.execute("INSERT INTO cache_links(source_path,line,text,target_path) VALUES(?1,?2,?3,?4)",params![path,line as i64,text,target]).map_err(|error|error.to_string())?;
                }
            }
            for (line, tag) in file.metadata.tags {
                tx.execute(
                    "INSERT INTO cache_tags(path,line,tag) VALUES(?1,?2,?3)",
                    params![path, line as i64, tag],
                )
                .map_err(|error| error.to_string())?;
            }
            for (line, text, checked) in file.metadata.tasks {
                tx.execute(
                    "INSERT INTO cache_tasks(path,line,text,checked) VALUES(?1,?2,?3,?4)",
                    params![path, line as i64, text, checked],
                )
                .map_err(|error| error.to_string())?;
            }
        }
        tx.commit().map_err(|error| error.to_string())?;
        Ok(report)
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
        let root = PathBuf::from(self.workspace()?.ok_or("Choose a workspace first.")?);
        let path = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            root.join(path)
        };
        let path = path.canonicalize().unwrap_or_else(|_| normalize(&path));
        if !path.starts_with(root) {
            return Err("Backlink target is outside the selected workspace.".into());
        }
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
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let file = match options.open(&file_path) {
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
fn line_number(source: &str, offset: usize) -> usize {
    source[..offset]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        + 1
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
                    line: line_number(source, range.start),
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
                line_number(source, range.start),
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
            line_number(source, offset),
            line_text(source, offset),
            target,
            true,
        ));
    }
    let tags = Regex::new(r"(?:^|[^\p{L}\p{N}_/])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)").unwrap();
    // Keep marker/quote/list syntax in sync with the editor's task recognizer.
    let tasks =
        Regex::new(r"^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]+)?\[([ xX]?)\](?:[ \t]+(.*))?$")
            .unwrap();
    let blocks = Regex::new(r"(?:^|[ \t])\^([A-Za-z0-9][A-Za-z0-9-]*)[ \t]*$").unwrap();
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
                    line: line_number(source, range.start),
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
