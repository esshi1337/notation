//! Workspace-scoped wiki lookup and explicit atomic creation. Resolution never
//! creates files, overwrites buffers, or chooses an ambiguous note silently.
use crate::{explorer, frontmatter, storage::Database};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Heading {
    pub text: String,
    pub line: usize,
    pub level: usize,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BlockReference {
    pub id: String,
    pub line: usize,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub path: String,
    pub name: String,
    pub title: String,
    pub relative_path: String,
    pub link: String,
    pub aliases: Vec<String>,
    pub headings: Vec<Heading>,
    pub blocks: Vec<BlockReference>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub status: String,
    pub target: String,
    pub alias: Option<String>,
    pub heading: Option<String>,
    pub path: Option<String>,
    pub candidates: Vec<Candidate>,
    pub create_path: Option<String>,
}
#[derive(Debug)]
pub struct Target {
    pub note: String,
    pub alias: Option<String>,
    pub heading: Option<String>,
}
fn separator(text: &str, delimiter: u8) -> Option<usize> {
    let mut escaped = false;
    for (index, byte) in text.bytes().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if byte == b'\\' {
            escaped = true;
        } else if byte == delimiter {
            return Some(index);
        }
    }
    None
}
fn unescape(text: &str) -> String {
    let mut result = String::new();
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\\'
            && chars
                .peek()
                .is_some_and(|next| matches!(next, '\\' | '|' | '#' | '[' | ']'))
        {
            result.push(chars.next().unwrap());
        } else {
            result.push(character);
        }
    }
    result
}
fn escape(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('#', "\\#")
        .replace('|', "\\|")
        .replace(']', "\\]")
}
pub fn parse_target(raw: &str) -> Result<Target, String> {
    if raw.len() > 2048 || raw.contains(['\n', '\r', '\0']) {
        return Err("Wiki target must fit on one line and be at most 2 KiB.".into());
    }
    let raw = raw.trim();
    let raw = raw
        .strip_prefix("[[")
        .and_then(|value| value.strip_suffix("]]"))
        .unwrap_or(raw);
    let (note, alias) = match separator(raw, b'|') {
        Some(index) => (&raw[..index], Some(unescape(&raw[index + 1..]))),
        None => (raw, None),
    };
    let (note, heading) = match separator(note, b'#') {
        Some(index) => (
            &note[..index],
            Some(unescape(&note[index + 1..]).trim().to_string()),
        ),
        None => (note, None),
    };
    let note = unescape(note).trim().to_string();
    if note.contains(':') {
        return Err("Wiki targets must be note paths, not URLs or drive paths.".into());
    }
    if note.is_empty() && heading.is_none() {
        return Err("Wiki target needs a note name or a heading.".into());
    }
    Ok(Target {
        note,
        alias,
        heading,
    })
}
fn source_folder(root: &Path, source: Option<&str>) -> Result<PathBuf, String> {
    match source {
        Some(source) => {
            let source = explorer::resolve_allow_missing(root, source)?;
            let parent = source
                .parent()
                .ok_or("Source note needs a parent folder.")?;
            explorer::resolve(root, &parent.to_string_lossy())
        }
        None => Ok(root.to_path_buf()),
    }
}
fn editable(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("md" | "markdown" | "mmd")
    )
}
fn safe_candidate(root: &Path, candidate: &Candidate) -> bool {
    explorer::resolve(root, &candidate.path).is_ok_and(|path| path.is_file() && editable(&path))
}
fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => (),
            component => result.push(component.as_os_str()),
        }
    }
    result
}
fn matches_note(candidate: &Candidate, note: &str) -> bool {
    candidate.name == note
        || Path::new(&candidate.name)
            .file_stem()
            .is_some_and(|stem| stem == note)
        || candidate.aliases.iter().any(|alias| alias == note)
}
fn current(candidate: &Candidate, folder: &Path) -> bool {
    Path::new(&candidate.path).parent() == Some(folder)
}
fn suggestions(root: &Path, folder: &Path, mut candidates: Vec<Candidate>) -> Vec<Candidate> {
    for candidate in &mut candidates {
        let path = Path::new(&candidate.path);
        candidate.relative_path = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let link = if current(candidate, folder) {
            candidate.name.clone()
        } else {
            candidate.relative_path.clone()
        };
        let link = if Path::new(&link)
            .extension()
            .is_some_and(|extension| extension == "md")
        {
            link.strip_suffix(".md").unwrap().to_string()
        } else {
            link
        };
        candidate.link = escape(&link);
    }
    candidates.sort_by(|a, b| {
        (!current(a, folder))
            .cmp(&(!current(b, folder)))
            .then_with(|| a.relative_path.cmp(&b.relative_path))
    });
    candidates
}
impl Database {
    pub(crate) fn indexed_notes(&self) -> Result<Vec<Candidate>, String> {
        let connection = self.lock()?;
        let mut statement=connection.prepare("SELECT f.path,f.name,f.title,m.json FROM cache_files f LEFT JOIN cache_frontmatter m ON m.path=f.path ORDER BY f.path").map_err(|error|error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                let metadata: Option<String> = row.get(3)?;
                let parsed = metadata.and_then(|value| {
                    serde_json::from_str::<frontmatter::Frontmatter>(&value).ok()
                });
                let aliases = frontmatter::string_list(
                    parsed.as_ref().map(|front| &front.properties["aliases"]),
                );
                Ok(Candidate {
                    path: row.get(0)?,
                    name: row.get(1)?,
                    title: row.get(2)?,
                    relative_path: String::new(),
                    link: String::new(),
                    aliases,
                    headings: vec![],
                    blocks: vec![],
                })
            })
            .map_err(|error| error.to_string())?;
        let mut result = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT path,text,line,level FROM cache_headings ORDER BY path,line LIMIT 20000",
            )
            .map_err(|error| error.to_string())?;
        let headings = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Heading {
                        text: row.get(1)?,
                        line: row.get::<_, i64>(2)? as usize,
                        level: row.get::<_, i64>(3)? as usize,
                    },
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut by_path = std::collections::HashMap::<String, Vec<Heading>>::new();
        for heading in headings {
            let (path, heading) = heading.map_err(|error| error.to_string())?;
            by_path.entry(path).or_default().push(heading);
        }
        for candidate in &mut result {
            candidate.headings = by_path.remove(&candidate.path).unwrap_or_default();
        }
        let mut statement = connection
            .prepare("SELECT path,id,line FROM cache_blocks ORDER BY path,line LIMIT 100000")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    BlockReference {
                        id: row.get(1)?,
                        line: row.get::<_, i64>(2)? as usize,
                    },
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut blocks = std::collections::HashMap::<String, Vec<BlockReference>>::new();
        for row in rows {
            let (path, block) = row.map_err(|error| error.to_string())?;
            blocks.entry(path).or_default().push(block);
        }
        for candidate in &mut result {
            candidate.blocks = blocks.remove(&candidate.path).unwrap_or_default();
        }
        Ok(result)
    }
    pub fn resolve_wiki_link(&self, raw: &str, source: Option<&str>) -> Result<Resolution, String> {
        let target = parse_target(raw)?;
        let root = explorer::workspace_root(self)?;
        let folder = source_folder(&root, source)?;
        let notes = self.indexed_notes()?;
        let mut matches = if target.note.is_empty() {
            let source =
                source.ok_or("Save the current note before resolving a heading-only wiki link.")?;
            let path = explorer::resolve(&root, source)?;
            notes
                .into_iter()
                .filter(|candidate| Path::new(&candidate.path) == path)
                .collect::<Vec<_>>()
        } else {
            let raw = Path::new(&target.note);
            let relative = if raw.is_absolute() {
                root.join(target.note.trim_start_matches('/'))
            } else {
                folder.join(raw)
            };
            let requested = normalize(&relative);
            explorer::resolve_allow_missing(&root, &requested.to_string_lossy())?;
            let mut local_paths = vec![requested.clone()];
            if requested.extension().is_none() {
                for extension in ["md", "markdown", "mmd"] {
                    local_paths.push(requested.with_extension(extension));
                }
            }
            let direct = notes
                .iter()
                .filter(|candidate| {
                    local_paths
                        .iter()
                        .any(|path| Path::new(&candidate.path) == path)
                })
                .cloned()
                .collect::<Vec<_>>();
            if !direct.is_empty() {
                direct
            } else if target.note.contains('/') {
                let absolute = normalize(&root.join(target.note.trim_start_matches('/')));
                explorer::resolve_allow_missing(&root, &absolute.to_string_lossy())?;
                let mut paths = vec![absolute.clone()];
                if absolute.extension().is_none() {
                    for extension in ["md", "markdown", "mmd"] {
                        paths.push(absolute.with_extension(extension));
                    }
                }
                notes
                    .into_iter()
                    .filter(|candidate| paths.iter().any(|path| Path::new(&candidate.path) == path))
                    .collect()
            } else {
                let all = notes
                    .into_iter()
                    .filter(|candidate| matches_note(candidate, &target.note))
                    .collect::<Vec<_>>();
                let local = all
                    .iter()
                    .filter(|candidate| current(candidate, &folder))
                    .cloned()
                    .collect::<Vec<_>>();
                if local.is_empty() {
                    all
                } else {
                    local
                }
            }
        };
        matches.retain(|candidate| safe_candidate(&root, candidate));
        let matches = suggestions(&root, &folder, matches);
        let status = match matches.len() {
            0 => "missing",
            1 => "resolved",
            _ => "ambiguous",
        };
        let create_path = if matches.is_empty() {
            creation_path(&root, &folder, &target.note)
                .ok()
                .map(|path| path.to_string_lossy().into_owned())
        } else {
            None
        };
        Ok(Resolution {
            status: status.into(),
            target: target.note,
            alias: target.alias,
            heading: target.heading,
            path: if matches.len() == 1 {
                Some(matches[0].path.clone())
            } else {
                None
            },
            candidates: matches,
            create_path,
        })
    }
    pub fn wiki_candidates(
        &self,
        query: &str,
        source: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<Candidate>, String> {
        if query.len() > 2048 {
            return Err("Wiki completion query exceeds 2 KiB.".into());
        }
        let root = explorer::workspace_root(self)?;
        let folder = source_folder(&root, source)?;
        let query = query.trim().trim_start_matches("[[");
        let query = match separator(query, b'|') {
            Some(index) => &query[..index],
            None => query,
        };
        let (note, heading) = match separator(query, b'#') {
            Some(index) => (
                &query[..index],
                Some(unescape(&query[index + 1..]).to_lowercase()),
            ),
            None => (query, None),
        };
        let note = unescape(note).to_lowercase();
        let mut candidates = self
            .indexed_notes()?
            .into_iter()
            .filter(|candidate| {
                candidate.name.to_lowercase().contains(&note)
                    || candidate
                        .path
                        .strip_prefix(root.to_string_lossy().as_ref())
                        .unwrap_or(&candidate.path)
                        .to_lowercase()
                        .contains(&note)
                    || candidate
                        .aliases
                        .iter()
                        .any(|alias| alias.to_lowercase().contains(&note))
            })
            .filter(|candidate| safe_candidate(&root, candidate))
            .collect::<Vec<_>>();
        if let Some(heading) = heading {
            for candidate in &mut candidates {
                if let Some(block) = heading.strip_prefix('^') {
                    candidate.headings.clear();
                    candidate
                        .blocks
                        .retain(|candidate| candidate.id.to_lowercase().contains(block));
                } else {
                    candidate
                        .headings
                        .retain(|candidate| candidate.text.to_lowercase().contains(&heading));
                    candidate.blocks.clear();
                }
            }
        }
        candidates = suggestions(&root, &folder, candidates);
        candidates.truncate(limit.unwrap_or(50).clamp(1, 200));
        Ok(candidates)
    }
    pub fn create_wiki_note(
        &self,
        raw: &str,
        source: Option<&str>,
        content: Option<&str>,
    ) -> Result<crate::documents::Document, String> {
        let resolution = self.resolve_wiki_link(raw, source)?;
        if resolution.status != "missing" {
            return Err("This wiki target already resolves to existing notes. Open or choose an existing note instead.".into());
        }
        let root = explorer::workspace_root(self)?;
        let folder = source_folder(&root, source)?;
        let path = creation_path(&root, &folder, &resolution.target)?;
        let content = content.unwrap_or("");
        if content.len() > crate::storage::MAX_CONTENT {
            return Err("New note exceeds the 4 MiB limit.".into());
        }
        let parent = path.parent().ok_or("Choose a note filename.")?;
        let mut staged = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| format!("Could not create note: {error}"))?;
        staged
            .write_all(content.as_bytes())
            .map_err(|error| error.to_string())?;
        staged
            .as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        // persist_noclobber atomically publishes the create_new temporary file;
        // an existing file or symlink at the destination is never replaced.
        staged.persist_noclobber(&path).map_err(|error| {
            format!("Could not create note without overwriting an existing path: {error}")
        })?;
        #[cfg(unix)]
        if let Ok(directory) = std::fs::File::open(parent) {
            let _ = directory.sync_all();
        }
        let path = path.to_str().ok_or("Note path is not valid UTF-8.")?;
        let mut document = crate::documents::Document {
            path: path.into(),
            content: content.into(),
            warning: None,
        };
        if let Err(error) = self.record_document(path, content, true) {
            document.warning = Some(format!(
                "Note created, but history could not be saved: {error}"
            ));
        }
        crate::storage::refresh_after_write(self, &mut document);
        Ok(document)
    }
}
fn creation_path(root: &Path, folder: &Path, note: &str) -> Result<PathBuf, String> {
    if note.is_empty() || note.contains(['\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("Choose a plain Markdown note name or a workspace-relative path.".into());
    }
    let raw = Path::new(note);
    let mut path = if raw.is_absolute() {
        root.join(note.trim_start_matches('/'))
    } else {
        folder.join(raw)
    };
    match path.extension() {
        None => {
            path.set_extension("md");
        }
        Some(extension) if extension == "md" => (),
        _ => return Err("New wiki notes use the .md extension.".into()),
    }
    let path = explorer::resolve_allow_missing(root, &path.to_string_lossy())?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "New note is outside the workspace.")?;
    if relative.components().any(|part| {
        part.as_os_str().to_string_lossy().starts_with('.')
            || matches!(
                part.as_os_str().to_str(),
                Some("node_modules" | "target" | "dist" | "build" | "vendor")
            )
    }) {
        return Err("New notes cannot be created in hidden or build directories.".into());
    }
    let parent = path.parent().ok_or("Choose a note filename.")?;
    explorer::resolve(root, &parent.to_string_lossy())?;
    if std::fs::symlink_metadata(&path).is_ok() {
        return Err("The note path already exists. It will not be overwritten.".into());
    }
    Ok(path)
}

/// Scan raw wiki spans after Markdown code/math/frontmatter exclusion, honoring
/// escaped delimiters so literal \[[text]] does not become a backlink.
pub fn spans(source: &str) -> Vec<(usize, String)> {
    let bytes = source.as_bytes();
    let mut result = Vec::new();
    let mut index = 0;
    while index + 1 < bytes.len() {
        if bytes[index] == b'\\' {
            index = (index + 2).min(bytes.len());
            continue;
        }
        if &bytes[index..index + 2] != b"[[" {
            index += 1;
            continue;
        }
        let start = index;
        index += 2;
        let body = index;
        while index + 1 < bytes.len() && bytes[index] != b'\n' && bytes[index] != b'\r' {
            if bytes[index] == b'\\' {
                index = (index + 2).min(bytes.len());
                continue;
            }
            if &bytes[index..index + 2] == b"]]" {
                let target = &source[body..index];
                if parse_target(target).is_ok() {
                    result.push((start, target.into()));
                }
                index += 2;
                break;
            }
            index += 1;
        }
    }
    result
}

#[derive(Debug, Serialize)]
pub struct PropertyDocument {
    pub path: String,
    pub properties: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<frontmatter::ParseError>,
}
#[derive(Debug, Deserialize)]
pub struct PropertyQuery {
    pub key: String,
    #[serde(default, deserialize_with = "query_value")]
    pub value: Option<Value>,
    pub limit: Option<usize>,
}
fn query_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}
impl Database {
    pub fn get_frontmatter(&self, path: Option<&str>) -> Result<Vec<PropertyDocument>, String> {
        let root = explorer::workspace_root(self)?;
        let path = path
            .map(|path| {
                explorer::resolve(&root, path).map(|path| path.to_string_lossy().into_owned())
            })
            .transpose()?;
        let connection = self.lock()?;
        let mut statement=connection.prepare("SELECT path,json FROM cache_frontmatter WHERE (?1 IS NULL OR path=?1) ORDER BY path LIMIT 10000").map_err(|error|error.to_string())?;
        let rows = statement
            .query_map([path], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        let mut result = Vec::new();
        for row in rows {
            let (path, metadata) = row.map_err(|error| error.to_string())?;
            let metadata: frontmatter::Frontmatter =
                serde_json::from_str(&metadata).map_err(|error| error.to_string())?;
            if metadata.present {
                result.push(PropertyDocument {
                    path,
                    properties: metadata.properties,
                    error: metadata.error,
                });
            }
        }
        Ok(result)
    }
    pub fn query_properties(&self, query: PropertyQuery) -> Result<Vec<PropertyDocument>, String> {
        if query.key.len() > 1024 {
            return Err("Property key exceeds 1 KiB.".into());
        }
        let value = query.value.map(|value| value.to_string());
        if value.as_ref().is_some_and(|value| value.len() > 64 * 1024) {
            return Err("Property query value exceeds 64 KiB.".into());
        }
        let connection = self.lock()?;
        let mut statement=connection.prepare("SELECT DISTINCT m.path,m.json FROM cache_frontmatter m JOIN cache_properties p ON p.path=m.path WHERE p.key=?1 AND (?2 IS NULL OR p.json_value=?2) ORDER BY m.path LIMIT ?3").map_err(|error|error.to_string())?;
        let rows = statement
            .query_map(
                params![
                    query.key,
                    value,
                    query.limit.unwrap_or(100).clamp(1, 500) as i64
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|error| error.to_string())?;
        let mut result = Vec::new();
        for row in rows {
            let (path, metadata) = row.map_err(|error| error.to_string())?;
            let metadata: frontmatter::Frontmatter =
                serde_json::from_str(&metadata).map_err(|error| error.to_string())?;
            result.push(PropertyDocument {
                path,
                properties: metadata.properties,
                error: metadata.error,
            });
        }
        Ok(result)
    }
}

pub(crate) fn indexed_matches(
    root: &Path,
    source: &Path,
    raw: &str,
    notes: &[Candidate],
) -> Vec<PathBuf> {
    indexed_matches_inner(root, source, raw, notes).unwrap_or_default()
}
fn indexed_matches_inner(
    root: &Path,
    source: &Path,
    raw: &str,
    notes: &[Candidate],
) -> Option<Vec<PathBuf>> {
    let target = parse_target(raw).ok()?;
    if target.note.is_empty() {
        return source.starts_with(root).then(|| vec![source.to_path_buf()]);
    }
    let folder = source.parent()?;
    let raw = Path::new(&target.note);
    let requested = normalize(&if raw.is_absolute() {
        root.join(target.note.trim_start_matches('/'))
    } else {
        folder.join(raw)
    });
    if !requested.starts_with(root) {
        return None;
    }
    let paths = |path: PathBuf| {
        let mut result = vec![path.clone()];
        if path.extension().is_none() {
            for extension in ["md", "markdown", "mmd"] {
                result.push(path.with_extension(extension));
            }
        }
        result
    };
    let local = paths(requested);
    let direct = notes
        .iter()
        .filter(|candidate| local.iter().any(|path| Path::new(&candidate.path) == path))
        .collect::<Vec<_>>();
    let matches = if !direct.is_empty() {
        direct
    } else if target.note.contains('/') {
        let requested = normalize(&root.join(target.note.trim_start_matches('/')));
        if !requested.starts_with(root) {
            return None;
        }
        let paths = paths(requested);
        notes
            .iter()
            .filter(|candidate| paths.iter().any(|path| Path::new(&candidate.path) == path))
            .collect()
    } else {
        let all = notes
            .iter()
            .filter(|candidate| matches_note(candidate, &target.note))
            .collect::<Vec<_>>();
        let local = all
            .iter()
            .copied()
            .filter(|candidate| current(candidate, folder))
            .collect::<Vec<_>>();
        if local.is_empty() {
            all
        } else {
            local
        }
    };
    Some(
        matches
            .into_iter()
            .map(|candidate| PathBuf::from(&candidate.path))
            .collect(),
    )
}
pub(crate) fn scoped_link(
    root: &Path,
    source: &Path,
    raw: &str,
    wiki: bool,
) -> Option<(String, Option<String>, Option<String>)> {
    let (target, heading, alias) = if wiki {
        let target = parse_target(raw).ok()?;
        (target.note, target.heading, target.alias)
    } else {
        if raw.starts_with('#') {
            return Some((
                String::new(),
                Some(
                    percent_encoding::percent_decode_str(raw.trim_start_matches('#'))
                        .decode_utf8()
                        .ok()?
                        .into_owned(),
                ),
                None,
            ));
        }
        let mut parts = raw.splitn(2, '#');
        let target = parts.next()?.split('?').next()?;
        let target = percent_encoding::percent_decode_str(target)
            .decode_utf8()
            .ok()?
            .into_owned();
        let heading = parts.next().and_then(|text| {
            percent_encoding::percent_decode_str(text)
                .decode_utf8()
                .ok()
                .map(|text| text.into_owned())
        });
        (target, heading, None)
    };
    if target.contains(':') {
        return None;
    }
    if target.is_empty() {
        return heading.is_some().then_some((target, heading, alias));
    }
    let path = Path::new(&target);
    let path = if path.is_absolute() {
        if wiki {
            root.join(target.trim_start_matches('/'))
        } else {
            path.to_path_buf()
        }
    } else {
        source.parent()?.join(path)
    };
    normalize(&path)
        .starts_with(root)
        .then_some((target, heading, alias))
}
