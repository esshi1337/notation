//! Read-only structured queries and graph snapshots over the disposable index.
//! No SQL, script, or YAML query text is evaluated here.
use crate::{explorer, storage::Database};
use rusqlite::{params_from_iter, types::Value as SqlValue, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;

const MAX_FILES: usize = 10_000;
const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchRequest {
    pub text: String,
    pub folder: Option<String>,
    pub tags: Vec<String>,
    pub tag_mode: TagMode,
    pub properties: Vec<PropertyFilter>,
    pub sort: Sort,
    pub sort_property: Option<String>,
    pub descending: bool,
    pub limit: Option<usize>,
    pub offset: usize,
}
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TagMode {
    #[default]
    All,
    Any,
}
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sort {
    #[default]
    Relevance,
    Title,
    Path,
}
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Operator {
    #[default]
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    Contains,
    Exists,
}
#[derive(Debug, Deserialize)]
pub struct PropertyFilter {
    pub key: String,
    #[serde(default)]
    pub op: Operator,
    #[serde(default, deserialize_with = "present_value")]
    pub value: Option<Value>,
}
fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}
#[derive(Debug, Serialize)]
pub struct SearchItem {
    pub path: String,
    pub name: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
    pub tags: Vec<String>,
    pub properties: Value,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub results: Vec<SearchItem>,
    pub total: usize,
    pub has_more: bool,
    pub next_offset: usize,
}
struct Bindings(Vec<SqlValue>);
impl Bindings {
    fn text(&mut self, text: impl Into<String>) -> String {
        self.0.push(SqlValue::Text(text.into()));
        format!("?{}", self.0.len())
    }
}

// Revalidate index identities against the active workspace. A stale symlink,
// deleted file, old workspace, or injected outside-cache row is never returned.
fn safe_paths(connection: &Connection, root: &Path) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare("SELECT path FROM cache_files ORDER BY path LIMIT 10000")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut paths = Vec::new();
    for row in rows {
        let path = row.map_err(|error| error.to_string())?;
        let candidate = Path::new(&path);
        let Ok(relative) = candidate.strip_prefix(root) else {
            continue;
        };
        if relative.components().any(|component| {
            component.as_os_str().to_string_lossy().starts_with('.')
                || matches!(
                    component.as_os_str().to_str(),
                    Some(
                        "node_modules"
                            | "target"
                            | "dist"
                            | "build"
                            | "vendor"
                            | "coverage"
                            | "__pycache__"
                    )
                )
        }) {
            continue;
        }
        if !matches!(
            candidate
                .extension()
                .and_then(|ext| ext.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("md" | "markdown" | "mmd")
        ) {
            continue;
        }
        if explorer::resolve(root, &path)
            .is_ok_and(|canonical| canonical == candidate && canonical.is_file())
        {
            paths.push(path);
        }
    }
    Ok(paths)
}
fn comparison(filter: &PropertyFilter, bindings: &mut Bindings) -> Result<String, String> {
    if filter.key.is_empty() || filter.key.len() > 1024 {
        return Err("Property filters need a key of 1–1024 bytes.".into());
    }
    let key = bindings.text(&filter.key);
    let prefix =
        format!("EXISTS(SELECT 1 FROM cache_properties p WHERE p.path=f.path AND p.key={key}");
    if matches!(filter.op, Operator::Exists) {
        return Ok(format!("{prefix})"));
    }
    let value = filter
        .value
        .as_ref()
        .ok_or("This property operator requires a typed value.")?;
    let encoded = value.to_string();
    if encoded.len() > 64 * 1024 {
        return Err("Property filter value exceeds 64 KiB.".into());
    }
    let equal = match value {
        Value::Number(_) => {
            let value = bindings.text(encoded.clone());
            format!("p.kind='number' AND json_extract(p.json_value,'$')=json_extract({value},'$')")
        }
        _ => {
            let value = bindings.text(encoded.clone());
            format!("p.json_value={value}")
        }
    };
    let condition = match filter.op {
        Operator::Eq => equal,
        Operator::Ne => format!("NOT({equal})"),
        Operator::Gt | Operator::Gte | Operator::Lt | Operator::Lte => {
            let operator = match filter.op {
                Operator::Gt => ">",
                Operator::Gte => ">=",
                Operator::Lt => "<",
                _ => "<=",
            };
            let kind = match value {
                Value::Number(_) => "number",
                Value::String(_) => "string",
                _ => {
                    return Err(
                        "Ordered property comparisons need a number or string value.".into(),
                    )
                }
            };
            let value = bindings.text(encoded);
            format!("p.kind='{kind}' AND json_extract(p.json_value,'$'){operator}json_extract({value},'$')")
        }
        Operator::Contains => {
            let value_json = bindings.text(encoded);
            let member=format!("EXISTS(SELECT 1 FROM json_each(p.json_value) member WHERE (member.type=json_type({value_json}) OR member.type IN('integer','real') AND json_type({value_json}) IN('integer','real')) AND (member.type IN('true','false','null') OR member.value=json_extract({value_json},'$')))");
            if let Value::String(text) = value {
                let text = bindings.text(text);
                format!("(p.kind='string' AND instr(json_extract(p.json_value,'$'),{text})>0 OR p.kind='array' AND {member})")
            } else {
                format!("p.kind='array' AND {member}")
            }
        }
        Operator::Exists => unreachable!(),
    };
    Ok(format!("{prefix} AND ({condition}))"))
}
fn text_query(text: &str) -> String {
    text.split_whitespace()
        .filter(|term| term.chars().any(char::is_alphanumeric))
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}
impl Database {
    pub fn search_workspace_advanced(&self, request: SearchRequest) -> Result<SearchPage, String> {
        if request.text.len() > 512 {
            return Err("Search text exceeds 512 bytes.".into());
        }
        if request.tags.len() > 32 || request.properties.len() > 32 {
            return Err("Search supports at most 32 tags and 32 property filters.".into());
        }
        if request.offset > MAX_FILES {
            return Err("Search offset exceeds the workspace index limit.".into());
        }
        let root = explorer::workspace_root(self)?;
        let folder = request
            .folder
            .as_ref()
            .map(|folder| explorer::resolve(&root, folder))
            .transpose()?;
        if folder.as_ref().is_some_and(|folder| !folder.is_dir()) {
            return Err("Search folder must be a workspace directory.".into());
        }
        let connection = self.lock()?;
        let paths = safe_paths(&connection, &root)?;
        let mut bindings = Bindings(vec![]);
        let scope =
            bindings.text(serde_json::to_string(&paths).map_err(|error| error.to_string())?);
        let mut cte = String::new();
        let mut from=format!(" FROM json_each({scope}) safe JOIN cache_files f ON f.path=safe.value LEFT JOIN cache_frontmatter m ON m.path=f.path");
        let mut conditions = Vec::new();
        let text = request.text.trim();
        let query = text_query(text);
        let text_search = !text.is_empty();
        let (score, snippet) = if text_search && !query.is_empty() {
            let query = bindings.text(query);
            cte=format!("WITH hits AS MATERIALIZED(SELECT path,bm25(cache_fts) score,snippet(cache_fts,2,'','','…',24) excerpt FROM cache_fts WHERE cache_fts MATCH {query}) ");
            from.push_str(" LEFT JOIN hits ON hits.path=f.path");
            let name = bindings.text(text);
            conditions.push(format!(
                "(hits.path IS NOT NULL OR instr(lower(f.name),lower({name}))>0)"
            ));
            (
                "COALESCE(hits.score,0.0)",
                "COALESCE(hits.excerpt,substr(f.content,1,160))",
            )
        } else {
            if text_search {
                let text = bindings.text(text);
                conditions.push(format!("instr(lower(f.name),lower({text}))>0"));
            }
            ("0.0", "substr(f.content,1,160)")
        };
        if let Some(folder) = folder {
            let prefix = bindings.text(format!("{}/", folder.to_string_lossy()));
            conditions.push(format!("instr(f.path,{prefix})=1"));
        }
        let mut tag_conditions = Vec::new();
        for tag in request.tags {
            let tag = tag.trim().trim_start_matches('#');
            if tag.is_empty() || tag.len() > 1024 {
                return Err("Tag filters need 1–1024 bytes.".into());
            }
            let tag = bindings.text(tag);
            tag_conditions.push(format!(
                "EXISTS(SELECT 1 FROM cache_tags t WHERE t.path=f.path AND t.tag={tag})"
            ));
        }
        if !tag_conditions.is_empty() {
            conditions.push(format!(
                "({})",
                tag_conditions.join(match request.tag_mode {
                    TagMode::All => " AND ",
                    TagMode::Any => " OR ",
                })
            ));
        }
        for filter in &request.properties {
            conditions.push(comparison(filter, &mut bindings)?);
        }
        let direction = if request.descending { "DESC" } else { "ASC" };
        let order = if let Some(property) = &request.sort_property {
            if property.is_empty() || property.len() > 1024 {
                return Err("Sort property needs 1–1024 bytes.".into());
            }
            let property = bindings.text(property);
            from.push_str(&format!(" LEFT JOIN cache_properties sorted ON sorted.path=f.path AND sorted.key={property}"));
            format!("CASE sorted.kind WHEN 'number' THEN 0 WHEN 'string' THEN 1 WHEN 'boolean' THEN 2 WHEN 'array' THEN 3 WHEN 'object' THEN 4 WHEN 'null' THEN 5 ELSE 6 END ASC,CASE WHEN sorted.kind='number' THEN json_extract(sorted.json_value,'$') END {direction},CASE WHEN sorted.kind IN('string','boolean','array','object') THEN json_extract(sorted.json_value,'$') END {direction},f.title COLLATE NOCASE,f.path")
        } else {
            match request.sort {
                Sort::Relevance if text_search => {
                    format!("{score} {direction},f.title COLLATE NOCASE,f.path")
                }
                Sort::Path => format!("f.path {direction}"),
                _ => format!("f.title COLLATE NOCASE {direction},f.path"),
            }
        };
        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", conditions.join(" AND "))
        };
        let total: i64 = connection
            .query_row(
                &format!("{cte}SELECT count(*){from}{where_clause}"),
                params_from_iter(bindings.0.iter()),
                |row| row.get(0),
            )
            .map_err(|error| format!("Search failed: {error}"))?;
        let limit = request.limit.unwrap_or(100).clamp(1, 500);
        let sql=format!("{cte}SELECT f.path,f.name,f.title,{snippet},{score},COALESCE(json_extract(m.json,'$.properties'),'{{}}'),COALESCE((SELECT json_group_array(tag) FROM(SELECT DISTINCT tag FROM cache_tags WHERE path=f.path ORDER BY tag)),'[]'){from}{where_clause} ORDER BY {order} LIMIT {limit} OFFSET {}",request.offset);
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params_from_iter(bindings.0.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, f64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut results = Vec::new();
        let mut bytes = 1024;
        for row in rows {
            let (path, name, title, snippet, score, properties, tags) =
                row.map_err(|error| error.to_string())?;
            let item = SearchItem {
                path,
                name,
                title,
                snippet,
                score,
                properties: serde_json::from_str(&properties).map_err(|error| error.to_string())?,
                tags: serde_json::from_str(&tags).map_err(|error| error.to_string())?,
            };
            let size = serde_json::to_vec(&item)
                .map_err(|error| error.to_string())?
                .len()
                + 1;
            if bytes + size > RESPONSE_LIMIT {
                if results.is_empty() {
                    return Err("One search result exceeds the 8 MiB response limit.".into());
                }
                break;
            }
            bytes += size;
            results.push(item);
        }
        let next_offset = request.offset + results.len();
        Ok(SearchPage {
            results,
            total: total as usize,
            has_more: next_offset < (total as usize),
            next_offset,
        })
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GraphRequest {
    pub focus: Option<String>,
    pub depth: Option<usize>,
    pub max_nodes: Option<usize>,
    pub max_edges: Option<usize>,
    pub include_unresolved: Option<bool>,
}
#[derive(Debug, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub path: String,
    pub name: String,
    pub title: String,
    pub tags: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
    pub line: usize,
    pub heading: Option<String>,
    pub alias: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct UnresolvedLink {
    pub source: String,
    pub line: usize,
    pub target: String,
    pub kind: String,
    pub status: String,
    pub candidates: Vec<String>,
    pub heading: Option<String>,
    pub alias: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct GraphTotals {
    pub nodes: usize,
    pub edges: usize,
    pub unresolved: usize,
}
#[derive(Debug, Serialize)]
pub struct GraphTruncated {
    pub nodes: bool,
    pub edges: bool,
    pub unresolved: bool,
}
#[derive(Debug, Serialize)]
pub struct GraphSnapshot {
    pub root: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub unresolved: Vec<UnresolvedLink>,
    pub totals: GraphTotals,
    pub truncated: GraphTruncated,
}
impl Database {
    pub fn graph_workspace(&self, request: GraphRequest) -> Result<GraphSnapshot, String> {
        let root = explorer::workspace_root(self)?;
        let focus = request
            .focus
            .as_ref()
            .map(|path| {
                explorer::resolve(&root, path).map(|path| path.to_string_lossy().into_owned())
            })
            .transpose()?;
        let connection = self.lock()?;
        let paths = safe_paths(&connection, &root)?
            .into_iter()
            .collect::<HashSet<_>>();
        if focus.as_ref().is_some_and(|focus| !paths.contains(focus)) {
            return Err(
                "The local graph focus is not indexed. Refresh the workspace first.".into(),
            );
        }
        let mut all_edges = Vec::new();
        let mut all_unresolved = Vec::new();
        let mut statement=connection.prepare("SELECT source_path,line,raw_target,kind,target_path,status,candidates_json,heading,alias FROM cache_graph_links ORDER BY source_path,line,rowid LIMIT 100000").map_err(|error|error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (source, line, target, kind, resolved, status, candidates, heading, alias) =
                row.map_err(|error| error.to_string())?;
            if !paths.contains(&source) {
                continue;
            }
            if let Some(resolved) = resolved {
                if paths.contains(&resolved) {
                    all_edges.push(GraphEdge {
                        source,
                        target: resolved,
                        kind,
                        line: line as usize,
                        heading,
                        alias,
                    });
                } else {
                    all_unresolved.push(UnresolvedLink {
                        source,
                        line: line as usize,
                        target,
                        kind,
                        status: "missing".into(),
                        candidates: vec![],
                        heading,
                        alias,
                    });
                }
            } else {
                let candidates = serde_json::from_str::<Vec<String>>(&candidates)
                    .map_err(|error| error.to_string())?
                    .into_iter()
                    .filter(|path| paths.contains(path))
                    .collect();
                all_unresolved.push(UnresolvedLink {
                    source,
                    line: line as usize,
                    target,
                    kind,
                    status,
                    candidates,
                    heading,
                    alias,
                });
            }
        }
        let selected = if let Some(focus) = focus {
            let depth = request.depth.unwrap_or(1).clamp(1, 5);
            let mut adjacency = HashMap::<&str, Vec<&str>>::new();
            for edge in &all_edges {
                adjacency
                    .entry(&edge.source)
                    .or_default()
                    .push(&edge.target);
                adjacency
                    .entry(&edge.target)
                    .or_default()
                    .push(&edge.source);
            }
            let mut selected = HashSet::from([focus.clone()]);
            let mut queue = VecDeque::from([(focus, 0)]);
            while let Some((path, level)) = queue.pop_front() {
                if level >= depth {
                    continue;
                }
                for neighbor in adjacency.get(path.as_str()).into_iter().flatten() {
                    if selected.insert((*neighbor).to_string()) {
                        queue.push_back(((*neighbor).to_string(), level + 1));
                    }
                }
            }
            selected
        } else {
            paths.clone()
        };
        let mut selected_paths = selected.iter().cloned().collect::<Vec<_>>();
        selected_paths.sort();
        let total_nodes = selected_paths.len();
        let max_nodes = request.max_nodes.unwrap_or(500).clamp(1, 2000);
        if let Some(focus) = request.focus.as_ref() {
            let focus = explorer::resolve(&root, focus)?
                .to_string_lossy()
                .into_owned();
            if let Some(index) = selected_paths.iter().position(|path| path == &focus) {
                selected_paths.swap(0, index);
            }
        }
        selected_paths.truncate(max_nodes);
        let mut nodes = Vec::new();
        let mut statement=connection.prepare("SELECT f.name,f.title,COALESCE((SELECT json_group_array(tag) FROM(SELECT DISTINCT tag FROM cache_tags WHERE path=f.path ORDER BY tag)),'[]') FROM cache_files f WHERE f.path=?1").map_err(|error|error.to_string())?;
        let mut bytes = root.to_string_lossy().len() + 1024;
        for path in selected_paths {
            let (name, title, tags): (String, String, String) = statement
                .query_row([&path], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(|error| error.to_string())?;
            let node = GraphNode {
                id: path.clone(),
                path,
                name,
                title,
                tags: serde_json::from_str(&tags).map_err(|error| error.to_string())?,
            };
            let size = serde_json::to_vec(&node)
                .map_err(|error| error.to_string())?
                .len()
                + 1;
            if bytes + size > RESPONSE_LIMIT {
                continue;
            }
            bytes += size;
            nodes.push(node);
        }
        let visible = nodes
            .iter()
            .map(|node| node.path.clone())
            .collect::<HashSet<_>>();
        let all_edges = all_edges
            .into_iter()
            .filter(|edge| selected.contains(&edge.source) && selected.contains(&edge.target))
            .collect::<Vec<_>>();
        let total_edges = all_edges.len();
        let mut edges = all_edges
            .into_iter()
            .filter(|edge| visible.contains(&edge.source) && visible.contains(&edge.target))
            .collect::<Vec<_>>();
        edges.truncate(request.max_edges.unwrap_or(5000).clamp(1, 20000));
        let mut budgeted_edges = Vec::new();
        for edge in edges {
            let size = serde_json::to_vec(&edge)
                .map_err(|error| error.to_string())?
                .len()
                + 1;
            if bytes + size > RESPONSE_LIMIT {
                break;
            }
            bytes += size;
            budgeted_edges.push(edge);
        }
        let edges = budgeted_edges;
        let all_unresolved = all_unresolved
            .into_iter()
            .filter(|link| selected.contains(&link.source))
            .collect::<Vec<_>>();
        let total_unresolved = all_unresolved.len();
        let include = request.include_unresolved.unwrap_or(true);
        let mut unresolved = if include {
            all_unresolved
                .into_iter()
                .filter(|link| visible.contains(&link.source))
                .collect::<Vec<_>>()
        } else {
            vec![]
        };
        unresolved.truncate(1000);
        let mut budgeted_unresolved = Vec::new();
        for link in unresolved {
            let size = serde_json::to_vec(&link)
                .map_err(|error| error.to_string())?
                .len()
                + 1;
            if bytes + size > RESPONSE_LIMIT {
                break;
            }
            bytes += size;
            budgeted_unresolved.push(link);
        }
        let unresolved = budgeted_unresolved;
        Ok(GraphSnapshot {
            root: root.to_string_lossy().into_owned(),
            truncated: GraphTruncated {
                nodes: total_nodes > nodes.len(),
                edges: total_edges > edges.len(),
                unresolved: include && total_unresolved > unresolved.len(),
            },
            nodes,
            edges,
            unresolved,
            totals: GraphTotals {
                nodes: total_nodes,
                edges: total_edges,
                unresolved: total_unresolved,
            },
        })
    }
}
