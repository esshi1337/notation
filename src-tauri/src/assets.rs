use crate::{explorer, storage::Database};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{fs::OpenOptions, io::Read, path::Path};
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub mime: String,
    pub data_url: String,
}
const LIMIT: usize = 20 * 1024 * 1024;
pub fn read(database: &Database, path: &str, source: Option<&str>) -> Result<Asset, String> {
    if path.is_empty() || path.len() > 4096 || path.contains(':') {
        return Err("Choose a workspace-local media path. Remote media is loaded only after an explicit click.".into());
    }
    let root = explorer::workspace_root(database)?;
    let folder = if let Some(source) = source {
        let source = explorer::resolve_allow_missing(&root, source)?;
        source
            .parent()
            .ok_or("Source document has no parent folder.")?
            .to_path_buf()
    } else {
        root.clone()
    };
    let requested = if Path::new(path).is_absolute() {
        Path::new(path).to_path_buf()
    } else {
        folder.join(path)
    };
    let path = explorer::resolve(&root, &requested.to_string_lossy())?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(&path)
        .map_err(|error| format!("Could not read media: {error}"))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Choose a regular media file.".into());
    }
    if metadata.len() > LIMIT as u64 {
        return Err("Local media exceeds the 20 MiB limit.".into());
    }
    let mut bytes = Vec::new();
    file.take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > LIMIT {
        return Err("Local media exceeds the 20 MiB limit.".into());
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "image/png",
        "jpg" | "jpeg" if bytes.starts_with(&[0xff, 0xd8, 0xff]) => "image/jpeg",
        "gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => "image/gif",
        "webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => "image/webp",
        "avif"
            if bytes.get(4..8) == Some(b"ftyp")
                && bytes
                    .windows(4)
                    .take(32)
                    .any(|window| window == b"avif" || window == b"avis") =>
        {
            "image/avif"
        }
        "svg" => {
            safe_svg(std::str::from_utf8(&bytes).map_err(|_| "SVG must be UTF-8 text.")?)?;
            "image/svg+xml"
        }
        "pdf" if bytes.starts_with(b"%PDF-") => "application/pdf",
        "mp3"
            if bytes.starts_with(b"ID3")
                || bytes.first() == Some(&0xff)
                    && bytes.get(1).is_some_and(|byte| byte & 0xe0 == 0xe0) =>
        {
            "audio/mpeg"
        }
        "wav" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE") => "audio/wav",
        "ogg" | "oga" if bytes.starts_with(b"OggS") => "audio/ogg",
        "flac" if bytes.starts_with(b"fLaC") => "audio/flac",
        "m4a" if bytes.get(4..8) == Some(b"ftyp") => "audio/mp4",
        "mp4" | "m4v" if bytes.get(4..8) == Some(b"ftyp") => "video/mp4",
        "webm" if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) => "video/webm",
        "ogv" if bytes.starts_with(b"OggS") => "video/ogg",
        _ => return Err(
            "This media type is unsupported or its file signature does not match its extension."
                .into(),
        ),
    };
    Ok(Asset {
        mime: mime.into(),
        data_url: format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
    })
}
/// SVG media and engine output are inert and self-contained. XML entities are
/// decoded before checking URLs; DTDs, script, foreign HTML and remote/file URLs
/// are rejected rather than allowing an implicit resource fetch.
pub fn safe_svg(svg: &str) -> Result<(), String> {
    let document = roxmltree::Document::parse_with_options(
        svg,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            nodes_limit: 200_000,
            ..Default::default()
        },
    )
    .map_err(|error| format!("Invalid or unsafe SVG: {error}"))?;
    if document.root_element().tag_name().name() != "svg" {
        return Err("SVG needs an svg root element.".into());
    }
    if document.descendants().any(|node| {
        node.pi()
            .is_some_and(|instruction| !matches!(instruction.target, "plantuml" | "plantuml-src"))
    }) {
        return Err("SVG processing instructions are not loaded automatically.".into());
    }
    for node in document.descendants().filter(|node| node.is_element()) {
        let name = node.tag_name().name().to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "script"
                | "iframe"
                | "object"
                | "embed"
                | "form"
                | "input"
                | "button"
                | "link"
                | "meta"
                | "audio"
                | "video"
                | "source"
                | "animate"
                | "animatetransform"
                | "animatemotion"
                | "set"
                | "mpath"
                | "discard"
        ) {
            return Err("SVG contains active content that cannot be loaded automatically.".into());
        }
        for attribute in node.attributes() {
            let key = attribute.name().to_ascii_lowercase();
            let value = attribute.value();
            if key.starts_with("on") {
                return Err("SVG event handlers are not allowed.".into());
            }
            if key == "srcset" {
                return Err(
                    "SVG responsive external image sources are not loaded automatically.".into(),
                );
            }
            if matches!(key.as_str(), "href" | "src" | "background" | "poster")
                && !safe_data_reference(value)
            {
                let link = name == "a"
                    && url::Url::parse(value).is_ok_and(|url| {
                        matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
                    });
                if !link {
                    return Err("SVG external resource links are not loaded automatically.".into());
                }
            }
            if matches!(
                key.as_str(),
                "style"
                    | "fill"
                    | "stroke"
                    | "filter"
                    | "clip-path"
                    | "mask"
                    | "cursor"
                    | "font-family"
            ) {
                safe_css(value)?;
            }
        }
        if name == "style" {
            let css = node
                .children()
                .filter_map(|node| node.text())
                .collect::<String>();
            safe_css(&css)?;
        }
    }
    Ok(())
}
fn safe_data_reference(value: &str) -> bool {
    value.is_empty()
        || value.starts_with('#')
        || value.starts_with("data:image/png;")
        || value.starts_with("data:image/jpeg;")
        || value.starts_with("data:image/gif;")
        || value.starts_with("data:image/webp;")
}
fn safe_css(css: &str) -> Result<(), String> {
    let lowered = css.to_ascii_lowercase();
    if lowered.contains("@import")
        || lowered.contains("expression(")
        || lowered.contains("javascript:")
        || lowered.contains('\\')
    {
        return Err("SVG contains external or active CSS.".into());
    }
    let urls = regex::Regex::new(r#"(?i)url\(\s*["']?\s*([^\s)'\"]+)"#).unwrap();
    for url in urls.captures_iter(css) {
        let target = &url[1];
        if !safe_data_reference(target)
            && !target.starts_with("data:font/")
            && !target.starts_with("data:application/font-")
            && !target.starts_with("data:application/x-font-")
        {
            return Err("SVG external CSS resources are not loaded automatically.".into());
        }
    }
    Ok(())
}
