//! Typst math in converter exports.
//!
//! The frontend marks every equation it rendered with Typst as an empty
//! `<span class="notation-typst-math">` carrying the source. Pandoc's HTML
//! reader keeps that span, and this module rewrites it in the document tree:
//! PDF output gets the source back as raw Typst, so the Typst engine typesets
//! it natively; Office output gets the TeX that Pandoc's Typst reader derives
//! from it (a native, editable equation), or an image when Pandoc cannot.
use serde_json::{json, Value};

pub const CLASS: &str = "notation-typst-math";
/// One document may not carry more equations than this through an export.
pub const LIMIT: usize = 5000;
const SOURCE_LIMIT: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Equation {
    pub source: String,
    pub display: bool,
    /// Standalone SVG of the rendered equation, for the image fallback.
    pub svg: Option<String>,
    /// Size in pt at the 10 pt text size the equation was rendered with.
    pub width: f64,
    pub height: f64,
}

fn equation(value: &Value) -> Option<Equation> {
    if value.get("t")?.as_str()? != "Span" {
        return None;
    }
    let attributes = value.get("c")?.get(0)?;
    if !attributes
        .get(1)?
        .as_array()?
        .iter()
        .any(|class| class.as_str() == Some(CLASS))
    {
        return None;
    }
    // A span that only shares the class (written by hand in a note) is not
    // an equation and stays ordinary text.
    let pairs = attributes.get(2)?.as_array()?;
    if !pairs.iter().any(|pair| {
        matches!(
            pair.get(0).and_then(Value::as_str),
            Some("typst" | "data-typst")
        )
    }) {
        return None;
    }
    let mut found = Equation {
        source: String::new(),
        display: false,
        svg: None,
        width: 0.0,
        height: 0.0,
    };
    for pair in pairs {
        let (Some(key), Some(value)) = (
            pair.get(0).and_then(Value::as_str),
            pair.get(1).and_then(Value::as_str),
        ) else {
            continue;
        };
        // Pandoc's HTML reader drops the `data-` prefix, except where the
        // remaining name is an attribute of its own (`width`, `height`).
        match key.strip_prefix("data-").unwrap_or(key) {
            "typst" => found.source = value.to_string(),
            "display" => found.display = value == "1",
            "svg" => found.svg = Some(value.to_string()),
            "width" => found.width = value.parse().unwrap_or(0.0),
            "height" => found.height = value.parse().unwrap_or(0.0),
            _ => (),
        }
    }
    Some(found)
}

/// Visit every marked equation in document order. `replace` returns the node
/// that takes the equation's place, or `None` to leave the span as it is.
fn visit(
    value: &mut Value,
    replace: &mut dyn FnMut(Equation) -> Result<Option<Value>, String>,
) -> Result<(), String> {
    if let Some(found) = equation(value) {
        if let Some(replacement) = replace(found)? {
            *value = replacement;
        }
        return Ok(());
    }
    match value {
        Value::Object(object) => {
            for value in object.values_mut() {
                visit(value, replace)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                visit(value, replace)?;
            }
        }
        _ => (),
    }
    Ok(())
}

/// The marked equations of a Pandoc document, in document order.
pub fn equations(document: &mut Value) -> Result<Vec<Equation>, String> {
    let mut found = Vec::new();
    visit(document, &mut |equation| {
        if found.len() >= LIMIT {
            return Err(format!("Export exceeds {LIMIT} equations."));
        }
        found.push(equation);
        Ok(None)
    })?;
    Ok(found)
}

/// Replace the marked equations, in the order [`equations`] returned them.
pub fn replace(document: &mut Value, replacements: Vec<Value>) -> Result<(), String> {
    let mut replacements = replacements.into_iter();
    visit(document, &mut |_| {
        replacements
            .next()
            .map(Some)
            .ok_or_else(|| "The exported equations changed while they were converted.".to_string())
    })
}

/// The equation as Typst markup: `$x$` inline, `$ x $` display.
///
/// The source arrives from the webview, so it is checked again here: an
/// unescaped `$` would end the equation and let the rest run as document
/// markup.
pub fn markup(equation: &Equation) -> Result<String, String> {
    let body = equation.source.trim();
    if body.is_empty() {
        return Err("An exported Typst equation is empty.".into());
    }
    if body.len() > SOURCE_LIMIT {
        return Err("An exported Typst equation exceeds 16 KiB.".into());
    }
    let mut characters = body.chars();
    while let Some(character) = characters.next() {
        match character {
            '\\' => {
                characters.next();
            }
            '$' => return Err("An exported Typst equation contains an unescaped $.".into()),
            _ => (),
        }
    }
    Ok(if equation.display {
        format!("$ {body} $")
    } else if body.ends_with('\\') {
        // A trailing backslash is a line break; keep it off the delimiter.
        format!("${body} $")
    } else {
        format!("${body}$")
    })
}

/// A raw Typst inline for PDF output.
pub fn raw_typst(markup: &str) -> Value {
    json!({"t":"RawInline","c":["typst", markup]})
}

/// A TeX math inline for Office output.
pub fn tex_math(tex: &str, display: bool) -> Value {
    json!({"t":"Math","c":[{"t": if display { "DisplayMath" } else { "InlineMath" }}, tex]})
}

/// An image of the equation, sized for 11 pt body text.
pub fn image(name: &str, equation: &Equation) -> Value {
    let inches = |points: f64| format!("{:.3}in", (points * 1.1 / 72.0).clamp(0.02, 7.0));
    json!({"t":"Image","c":[
        ["", [], [["width", inches(equation.width)], ["height", inches(equation.height)]]],
        [{"t":"Str","c": equation.source.trim()}],
        [name, ""]
    ]})
}

/// The source as inline code, when nothing else can represent the equation.
pub fn code(equation: &Equation) -> Value {
    json!({"t":"Code","c":[["", [], []], equation.source.trim()]})
}

/// One Typst document with each equation in its own paragraph.
pub fn batch(markup: &[String]) -> String {
    markup.join("\n\n") + "\n"
}

/// The TeX of each equation in a document Pandoc read from [`batch`], if it
/// has exactly one math element per paragraph and one paragraph per equation.
pub fn converted(document: &Value, expected: usize) -> Option<Vec<String>> {
    let blocks = document.get("blocks")?.as_array()?;
    if blocks.len() != expected {
        return None;
    }
    blocks
        .iter()
        .map(|block| {
            let inlines = block.get("c")?.as_array()?;
            if block.get("t")?.as_str()? != "Para" || inlines.len() != 1 {
                return None;
            }
            let math = &inlines[0];
            if math.get("t")?.as_str()? != "Math" {
                return None;
            }
            Some(math.get("c")?.get(1)?.as_str()?.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(source: &str, display: bool) -> Value {
        json!({"t":"Span","c":[["",[CLASS],[["typst",source],["display", if display {"1"} else {"0"}],["data-width","12.5"],["data-height","7"],["svg","<svg/>"]]],[]]})
    }
    fn document() -> Value {
        json!({"pandoc-api-version":[1,23,1,2],"meta":{},"blocks":[
            {"t":"Para","c":[{"t":"Str","c":"A"},{"t":"Space"},span("a/b", false),{"t":"Space"},{"t":"Math","c":[{"t":"InlineMath"},"\\frac{a}{b}"]}]},
            {"t":"BlockQuote","c":[{"t":"Para","c":[span("sum_(i=1)^n x_i", true)]}]},
            {"t":"Para","c":[{"t":"Span","c":[["",["other"],[]],[{"t":"Str","c":"kept"}]]},{"t":"Span","c":[["",[CLASS],[["display","1"]]],[{"t":"Str","c":"handwritten"}]]}]}
        ]})
    }

    #[test]
    fn finds_marked_equations_in_document_order_and_ignores_other_spans() {
        let mut ast = document();
        let found = equations(&mut ast).unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].source.as_str(), found[0].display), ("a/b", false));
        assert_eq!(
            (found[1].source.as_str(), found[1].display),
            ("sum_(i=1)^n x_i", true)
        );
        assert_eq!((found[0].width, found[0].height), (12.5, 7.0));
        assert_eq!(found[0].svg.as_deref(), Some("<svg/>"));
        assert_eq!(ast, document(), "collecting does not change the document");
    }

    #[test]
    fn pdf_replacement_is_raw_typst_and_leaves_tex_math_alone() {
        let mut ast = document();
        let replacements = equations(&mut ast)
            .unwrap()
            .iter()
            .map(|equation| raw_typst(&markup(equation).unwrap()))
            .collect();
        replace(&mut ast, replacements).unwrap();
        let text = ast.to_string();
        assert!(
            text.contains(r#"{"c":["typst","$a/b$"],"t":"RawInline"}"#),
            "{text}"
        );
        assert!(text.contains(r#"{"c":["typst","$ sum_(i=1)^n x_i $"],"t":"RawInline"}"#));
        assert!(text.contains(r#"\\frac{a}{b}"#));
        assert!(text.contains("kept"));
        // A hand-written span with the class but no source is left alone.
        assert!(text.contains("handwritten"));
        assert_eq!(text.matches(CLASS).count(), 1);
    }

    #[test]
    fn replacement_count_must_match() {
        let mut ast = document();
        assert!(replace(&mut ast, vec![raw_typst("$x$")]).is_err());
    }

    #[test]
    fn markup_rejects_sources_that_would_leave_the_equation() {
        let equation = |source: &str, display| Equation {
            source: source.into(),
            display,
            svg: None,
            width: 1.0,
            height: 1.0,
        };
        assert_eq!(markup(&equation(" x ", false)).unwrap(), "$x$");
        assert_eq!(markup(&equation("x", true)).unwrap(), "$ x $");
        assert_eq!(markup(&equation("x \\", false)).unwrap(), "$x \\ $");
        assert_eq!(markup(&equation("a \\$ b", false)).unwrap(), "$a \\$ b$");
        assert!(markup(&equation("x$ #import \"evil.typ\" $y", false)).is_err());
        assert!(markup(&equation("x \\\\$", false)).is_err());
        assert!(markup(&equation("   ", false)).is_err());
        assert!(markup(&equation(&"x".repeat(17_000), false)).is_err());
    }

    #[test]
    fn converted_requires_one_math_paragraph_per_equation() {
        let read = json!({"blocks":[
            {"t":"Para","c":[{"t":"Math","c":[{"t":"InlineMath"},"\\frac{a}{b}"]}]},
            {"t":"Para","c":[{"t":"Math","c":[{"t":"DisplayMath"},"x^{2}"]}]}
        ]});
        assert_eq!(
            converted(&read, 2),
            Some(vec!["\\frac{a}{b}".to_string(), "x^{2}".to_string()])
        );
        assert_eq!(converted(&read, 3), None);
        let mixed = json!({"blocks":[{"t":"Para","c":[{"t":"Str","c":"x"},{"t":"Math","c":[{"t":"InlineMath"},"x"]}]}]});
        assert_eq!(converted(&mixed, 1), None);
        assert_eq!(batch(&["$a$".into(), "$ b $".into()]), "$a$\n\n$ b $\n");
    }

    #[test]
    fn office_nodes_carry_display_style_and_image_size() {
        assert_eq!(
            tex_math("x", true),
            json!({"t":"Math","c":[{"t":"DisplayMath"},"x"]})
        );
        let equation = Equation {
            source: " a/b ".into(),
            display: false,
            svg: None,
            width: 72.0,
            height: 36.0,
        };
        let node = image("typst-math-1.png", &equation);
        assert_eq!(node["c"][0][2][0], json!(["width", "1.100in"]));
        assert_eq!(node["c"][0][2][1], json!(["height", "0.550in"]));
        assert_eq!(node["c"][2][0], "typst-math-1.png");
        assert_eq!(code(&equation)["c"][1], "a/b");
    }
}
