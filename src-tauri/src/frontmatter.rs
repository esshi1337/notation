//! Bounded, read-only YAML metadata parsing. The original Markdown/YAML is
//! never serialized back by this module, so comments and unknown syntax stay intact.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_YAML: usize = 256 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseError {
    pub message: String,
    pub line: Option<usize>,
    pub column: Option<usize>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frontmatter {
    pub present: bool,
    pub closed: bool,
    pub properties: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ParseError>,
    /// UTF-16 offset for JavaScript/CodeMirror consumers.
    pub body_offset: usize,
    #[serde(skip)]
    pub(crate) byte_end: usize,
}
impl Default for Frontmatter {
    fn default() -> Self {
        Self {
            present: false,
            closed: false,
            properties: json!({}),
            error: None,
            body_offset: 0,
            byte_end: 0,
        }
    }
}
fn failure(message: impl Into<String>, line: Option<usize>, column: Option<usize>) -> ParseError {
    ParseError {
        message: message.into().chars().take(4096).collect(),
        line,
        column,
    }
}
pub fn parse(content: &str) -> Frontmatter {
    let bom = if content.starts_with('\u{feff}') {
        3
    } else {
        0
    };
    let source = &content[bom..];
    let first = source.split_inclusive('\n').next().unwrap_or("");
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return Frontmatter::default();
    }
    let start = bom + first.len();
    let mut offset = start;
    let mut closing = None;
    for line in content[start..].split_inclusive('\n') {
        if matches!(line.trim_end_matches(['\r', '\n']), "---" | "...") {
            closing = Some((offset, offset + line.len()));
            break;
        }
        offset += line.len();
    }
    let Some((yaml_end, body_start)) = closing else {
        return Frontmatter {
            present: true,
            closed: false,
            properties: json!({}),
            error: Some(failure(
                "Frontmatter is missing its closing --- or ... delimiter.",
                Some(1),
                Some(1),
            )),
            body_offset: 0,
            byte_end: 0,
        };
    };
    let mut result = Frontmatter {
        present: true,
        closed: true,
        properties: json!({}),
        error: None,
        body_offset: content[..body_start].encode_utf16().count(),
        byte_end: body_start,
    };
    let yaml = &content[start..yaml_end];
    if yaml.len() > MAX_YAML {
        result.error = Some(failure(
            "Frontmatter exceeds the 256 KiB metadata limit.",
            Some(2),
            Some(1),
        ));
        return result;
    }
    let options = serde_saphyr::options! {
        emit_comments:false,
        with_snippet:false,
        duplicate_keys:serde_saphyr::DuplicateKeyPolicy::Error,
        merge_keys:serde_saphyr::MergeKeyPolicy::AsOrdinary,
        strict_booleans:true,
        reject_unsupported_tags:true,
        alias_limits:serde_saphyr::alias_limits!{max_total_replayed_events:20_000,max_replay_stack_depth:32,max_alias_expansions_per_anchor:100},
        budget:serde_saphyr::budget!{max_depth:64,flow_nesting_limit:64,max_events:50_000,max_nodes:20_000,max_aliases:100,max_anchors:100,max_total_scalar_bytes:1024*1024,max_documents:1},
    };
    match serde_saphyr::from_str_with_options::<Value>(yaml, options) {
        Ok(Value::Null) => (),
        Ok(properties) if properties.is_object() => {
            if properties.to_string().len() > 1024 * 1024 {
                result.error = Some(failure(
                    "Expanded frontmatter exceeds the 1 MiB metadata limit.",
                    Some(2),
                    Some(1),
                ));
            } else {
                result.properties = properties;
            }
        }
        Ok(_) => {
            result.error = Some(failure(
                "Frontmatter must be a mapping of property names to values.",
                Some(2),
                Some(1),
            ))
        }
        Err(error) => {
            let location = error.location();
            result.error = Some(failure(
                error.to_string(),
                location
                    .as_ref()
                    .map(|location| location.line() as usize + 1),
                location.as_ref().map(|location| location.column() as usize),
            ));
        }
    }
    result
}
pub fn string_list(value: Option<&Value>) -> Vec<String> {
    let values: Vec<&str> = match value {
        Some(Value::String(value)) => vec![value.as_str()],
        Some(Value::Array(values)) => values.iter().filter_map(Value::as_str).collect(),
        _ => vec![],
    };
    let mut result = values
        .into_iter()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    result.sort();
    result.dedup();
    result
}
