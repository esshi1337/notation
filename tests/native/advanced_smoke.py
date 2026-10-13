#!/usr/bin/env python3
"""Native workspace search, query, graph, and local-media integration smoke.

All data and app state live under a temporary XDG profile and workspace. The
test drives the actual packaged Tauri UI through W3C WebDriver.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import tempfile
import uuid
import zipfile

import smoke
import dialogs


def click(client: smoke.Client, element: str) -> None:
    client.element_command(element, "/click")


def open_workspace_panel(client: smoke.Client) -> None:
    if not client.execute("return Boolean(document.querySelector('[aria-label=\\\"Workspace\\\"]'))"):
        click(client, smoke.button(client, "Workspace"))


def search_for(client: smoke.Client, text: str) -> None:
    open_workspace_panel(client)
    field = client.find("[aria-label='Search notes']")
    client.element_command(field, "/clear")
    if text:
        client.send_keys(field, text)


def wait_preview(client: smoke.Client) -> None:
    smoke.wait_for(
        client,
        "document.querySelector('.preview-pane [aria-label=\\\"Document preview\\\"]')?.getAttribute('aria-busy') === 'false'",
        "current preview render",
    )


def invoke_native(client: smoke.Client, command: str, arguments: dict[str, object] | None = None) -> object:
    script = """
const done = arguments[arguments.length - 1];
window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1] || {}).then(
  value => done({ value }), error => done({ error: String(error) })
);
"""
    value = client.execute_async(script, [command, arguments or {}])
    if not isinstance(value, dict) or "error" in value:
        raise smoke.WebDriverError(f"Native invoke {command} failed: {value!r}")
    return value.get("value")


def run(app: Path) -> None:
    if not app.is_file() or not os.access(app, os.X_OK):
        raise FileNotFoundError(f"App launcher is missing or not executable: {app}")
    smoke.assert_ports_available()
    client = smoke.Client(smoke.BASE_URL)
    driver: subprocess.Popen[bytes] | None = None
    driver_log = None

    with tempfile.TemporaryDirectory(prefix="notation-advanced-smoke-") as temporary:
        root = Path(temporary)
        data, config, workspace = root / "data", root / "config", root / "workspace"
        for path in (data, config, workspace):
            path.mkdir(parents=True, exist_ok=True)

        # A tiny valid PNG (1 x 1) exercises the native workspace asset reader.
        (workspace / "pixel.png").write_bytes(base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS8sAAAAASUVORK5CYII="
        ))
        (workspace / "Alpha.md").write_text(
            "---\ntitle: Alpha\nstatus: active\npriority: 3\ntags: [project, urgent]\n---\n"
            "# Alpha\n\nAlpha points to [[Beta]].\n",
            encoding="utf-8",
        )
        (workspace / "Beta.md").write_text(
            "---\ntitle: Beta\nstatus: active\npriority: 7\ntags: [project]\n---\n"
            "# Beta\n\nBeta points back to [[Alpha]].\n",
            encoding="utf-8",
        )
        (workspace / "Archive.md").write_text(
            "---\ntitle: Archive\nstatus: archived\npriority: 1\ntags: [project]\n---\n"
            "# Archive\n\nOld notes.\n",
            encoding="utf-8",
        )
        query_text = (
            "# Active notes\n\n"
            "```query\nview: table\ncolumns: [title, status]\n"
            "where:\n  - key: status\n    op: eq\n    value: active\n"
            "sort:\n  by: priority\n  direction: desc\n```\n"
        )
        (workspace / "query.md").write_text(query_text, encoding="utf-8")
        media_text = "# Local media\n\n![Markdown pixel](pixel.png)\n\n![[pixel.png]]\n"
        (workspace / "media.md").write_text(media_text, encoding="utf-8")
        citation_text = (
            "---\nreferences:\n  - id: doe2020\n    type: book\n    title: Test Book\n"
            "    author:\n      - family: Doe\n        given: Jane\n"
            "    issued:\n      date-parts: [[2020]]\n---\n"
            "# Citation fixture\n\nA fact [@doe2020].\n"
        )
        (workspace / "citations.md").write_text(citation_text, encoding="utf-8")
        diagrams_text = (
            "# Bundled diagram renderers\n\n"
            "```d2\nalpha: Alpha\nbeta: Beta\nalpha -> beta: relates\n```\n\n"
            "```plantuml\n@startuml\nAlice -> Bob: hello\n@enduml\n```\n\n"
            "```dot\ndigraph {\n  Native -> Rendered\n}\n```\n"
        )
        (workspace / "diagrams.md").write_text(diagrams_text, encoding="utf-8")
        export_text = (
            "# Native export pipeline\n\n"
            "| Item | Value |\n| --- | --- |\n| Offline row | preserved |\n\n"
            "The equation is $x^2$.\n\n"
            "```mermaid\nflowchart LR\n  A[Native export] --> B[SVG asset]\n```\n"
        )
        (workspace / "export.md").write_text(export_text, encoding="utf-8")
        pdf_embed_text = "# PDF workspace embed\n\n![[native-ui-export.pdf]]\n"
        (workspace / "pdf-embed.md").write_text(pdf_embed_text, encoding="utf-8")
        canvas_path = workspace / "board.canvas"
        canvas_original = '{\n  "nodes": [],\n  "edges": []\n}\n'
        canvas_path.write_text(canvas_original, encoding="utf-8")

        env = os.environ.copy()
        env["XDG_DATA_HOME"], env["XDG_CONFIG_HOME"] = str(data), str(config)
        env["TAURI_WEBVIEW_AUTOMATION"] = "true"
        log_path = root / "tauri-driver.log"
        driver_log = log_path.open("wb")
        try:
            driver = subprocess.Popen(
                [str(smoke.DRIVER), "--port", str(smoke.DRIVER_PORT), "--native-port", str(smoke.NATIVE_PORT),
                 "--native-driver", str(smoke.WEBDRIVER)],
                stdin=subprocess.DEVNULL, stdout=driver_log, stderr=subprocess.STDOUT,
                env=env, start_new_session=True,
            )
            smoke.wait_for_driver(driver, log_path)
            client.create_session(app)
            print("Advanced smoke WebDriver session started", flush=True)
            smoke.wait_for(client, "document.querySelector('main.app')", "native app UI")
            url = client.execute("return location.href")
            smoke.require("localhost:1420" not in url, f"Native app loaded a development server: {url}")

            print("Indexing temporary typed-property workspace", flush=True)
            open_workspace_panel(client)
            folder = client.find("[aria-label='Workspace folder']")
            client.element_command(folder, "/clear")
            client.send_keys(folder, str(workspace))
            click(client, smoke.button(client, "Open workspace"))
            smoke.wait_for(
                client,
                "document.querySelector('[aria-label=\\\"Workspace\\\"] .panel-status')?.innerText.includes('indexed')",
                "workspace indexing",
            )

            print("Filtering indexed YAML properties", flush=True)
            filters = client.find("[aria-label='Workspace'] details.search-filters summary")
            click(client, filters)
            for selector, value in (
                ("[aria-label='Search property key']", "status"),
                ("[aria-label='Search property value']", "active"),
                ("[aria-label='Search sort']", "priority"),
            ):
                field = client.find(selector)
                client.element_command(field, "/clear")
                client.send_keys(field, value)
            smoke.wait_for(
                client,
                "Array.from(document.querySelectorAll('[aria-label=Workspace] .note-result[aria-label]')).some(e=>e.getAttribute('aria-label')==='Open note: Alpha.md') && Array.from(document.querySelectorAll('[aria-label=Workspace] .note-result[aria-label]')).some(e=>e.getAttribute('aria-label')==='Open note: Beta.md')",
                "active Alpha and Beta results",
            )
            smoke.wait_for(
                client,
                "document.querySelector('[aria-label=\\\"Workspace\\\"] .workspace-results')?.innerText.includes('2 of 2 matching notes')",
                "typed-property result count updates",
                timeout=30,
            )
            result_names = client.execute(
                "return Array.from(document.querySelectorAll('[aria-label=Workspace] .note-result[aria-label]')).map(e=>e.getAttribute('aria-label'))"
            )
            smoke.require("Open note: Archive.md" not in result_names, f"Property filter included archived note: {result_names!r}")
            smoke.require(result_names.index("Open note: Alpha.md") < result_names.index("Open note: Beta.md"),
                          f"Numeric property sort was not ascending: {result_names!r}")

            print("Rendering declarative YAML query against saved workspace metadata", flush=True)
            clear = client.find("//button[normalize-space(.)='Clear search filters']", using="xpath")
            click(client, clear)
            search_for(client, "Active notes")
            try:
                smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] [aria-label=\\\"Open note: query.md\\\"]')", "query note result")
            except AssertionError as error:
                diagnostics = client.execute("return {query:document.querySelector('[aria-label=\\\"Search notes\\\"]')?.value, status:document.querySelector('[aria-label=\\\"Workspace\\\"] .panel-status')?.innerText, results:document.querySelector('[aria-label=\\\"Workspace\\\"] .workspace-results')?.innerText, filters:Array.from(document.querySelectorAll('[aria-label=\\\"Workspace\\\"] .search-filters input')).map(e=>[e.getAttribute('aria-label'),e.value]), alerts:Array.from(document.querySelectorAll('[aria-label=\\\"Workspace\\\"] [role=\\\"alert\\\"]')).map(e=>e.innerText)}")
                direct = invoke_native(client, "search_workspace", {"query": "query.md", "limit": 50})
                screenshot = Path(__file__).resolve().parents[2] / "test-results" / "notation-advanced-search-failure.png"
                screenshot.parent.mkdir(parents=True, exist_ok=True)
                client.screenshot(screenshot)
                raise AssertionError(f"{error}; UI={diagnostics!r}; direct search_workspace={direct!r}; screenshot={screenshot}") from error
            click(client, client.find("[aria-label='Workspace'] [aria-label='Open note: query.md']"))
            smoke.wait_for_active_tab(client, "query.md")
            wait_preview(client)
            smoke.wait_for(client, "document.querySelector('.preview-pane [aria-label=\\\"Database view\\\"] table tbody tr')", "query result table")
            query_rows = client.execute("return Array.from(document.querySelectorAll('.preview-pane [aria-label=\\\"Database view\\\"] tbody tr')).map(row=>row.innerText)")
            smoke.require(len(query_rows) == 2 and any("Beta" in row for row in query_rows) and any("Alpha" in row for row in query_rows),
                          f"Metadata query returned unexpected rows: {query_rows!r}")
            smoke.require(query_rows[0].startswith("Beta"), f"Numeric descending sort was not applied: {query_rows!r}")
            smoke.require((workspace / "query.md").read_text(encoding="utf-8") == query_text,
                          "Rendering the query changed its Markdown source")

            print("Rendering local workspace image embed", flush=True)
            search_for(client, "Local media")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] [aria-label=\\\"Open note: media.md\\\"]')", "media note result")
            click(client, client.find("[aria-label='Workspace'] [aria-label='Open note: media.md']"))
            smoke.wait_for_active_tab(client, "media.md")
            wait_preview(client)
            smoke.wait_for(client, "document.querySelector('.preview-pane [aria-label=\\\"Media: Markdown pixel\\\"] img')?.naturalWidth === 1", "native Markdown local image decode")
            smoke.wait_for(client, "document.querySelector('.preview-pane [aria-label=\\\"Media: pixel.png\\\"] img')?.naturalWidth === 1", "native Obsidian local image embed")
            smoke.require((workspace / "media.md").read_text(encoding="utf-8") == media_text,
                          "Rendering local media changed the source file")

            print("Formatting native citations and bibliography", flush=True)
            search_for(client, "Citation fixture")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] [aria-label=\\\"Open note: citations.md\\\"]')", "citation note result")
            click(client, client.find("[aria-label='Workspace'] [aria-label='Open note: citations.md']"))
            smoke.wait_for_active_tab(client, "citations.md")
            client.element_command(client.find("[aria-label='Workspace'] [aria-label='Close workspace']"), "/click")
            wait_preview(client)
            smoke.wait_for(client, "document.querySelector('.preview-pane [aria-label=\\\"Bibliography\\\"]')?.innerText.includes('Test Book')", "formatted bibliography")
            bibliography = client.execute("return document.querySelector('.preview-pane [aria-label=\\\"Bibliography\\\"]').innerText")
            smoke.require("Doe" in bibliography and "2020" in bibliography and "Test Book" in bibliography,
                          f"Formatted bibliography omitted citation metadata: {bibliography!r}")
            smoke.require(client.execute("return document.querySelectorAll('.preview-pane .citation-reference').length === 1") is True,
                          "Citation reference was not formatted")
            citation_link = client.find(".preview-pane .citation-reference .citation")
            link_state = client.execute("const e=document.querySelector('.preview-pane .citation-reference a[href^=\"#\"]');if(!e)return null;e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {html:e.outerHTML,rect:{x:r.x,y:r.y,width:r.width,height:r.height},display:s.display,visibility:s.visibility,pointerEvents:s.pointerEvents,active:document.activeElement?.outerHTML}")
            try:
                click(client, citation_link)
            except smoke.WebDriverError as error:
                screenshot = Path(__file__).resolve().parents[2] / "test-results" / "notation-citation-click-failure.png"
                screenshot.parent.mkdir(parents=True, exist_ok=True)
                client.screenshot(screenshot)
                raise AssertionError(f"Citation reference was not clickable: {error}; element state={link_state!r}; screenshot={screenshot}") from error
            smoke.wait_for(client, "document.activeElement?.id.includes('ref-doe2020')", "citation jump to bibliography entry")
            back_link = client.find(".preview-pane [aria-label='Back to citation doe2020']")
            click(client, back_link)
            smoke.wait_for(client, "document.activeElement?.classList.contains('citation-reference')", "bibliography back-link to citation")
            smoke.require((workspace / "citations.md").read_text(encoding="utf-8") == citation_text,
                          "Formatting citations changed the Markdown source")

            print("Rendering bundled D2 and PlantUML diagrams", flush=True)
            search_for(client, "Bundled diagram renderers")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] [aria-label=\\\"Open note: diagrams.md\\\"]')", "diagram note result")
            click(client, client.find("[aria-label='Workspace'] [aria-label='Open note: diagrams.md']"))
            smoke.wait_for_active_tab(client, "diagrams.md")
            wait_preview(client)
            smoke.wait_for(
                client,
                "Array.from(document.querySelectorAll('.preview-pane .advanced-diagram')).length === 3 && Array.from(document.querySelectorAll('.preview-pane .advanced-diagram')).every(e=>e.getAttribute('aria-busy')==='false' && e.querySelector('svg'))",
                "D2 and PlantUML SVG output",
            )
            smoke.require((workspace / "diagrams.md").read_text(encoding="utf-8") == diagrams_text,
                          "Rendering diagrams changed their Markdown source")

            print("Checking bundled diagram and export engines", flush=True)
            engine_status = invoke_native(client, "engine_status")
            smoke.require(isinstance(engine_status, dict), f"Unexpected engine status: {engine_status!r}")
            engine_flags = engine_status.get("engines", {})
            resource_dir = Path(str(engine_status.get("resourceDir", "")))
            smoke.require(resource_dir.is_absolute() and (resource_dir / "manifest.json").is_file()
                          and (resource_dir / "bin" / "pandoc").is_file()
                          and (resource_dir / "bin" / "typst").is_file()
                          and (resource_dir / "plantuml.jar").is_file()
                          and not ("src-tauri" in resource_dir.parts),
                          f"Packaged engine resources were not loaded from the app resource tree: {resource_dir}")
            print(f"Packaged engines loaded from {resource_dir}", flush=True)
            smoke.require(engine_status.get("available") is True and engine_flags.get("pandoc") is True and engine_flags.get("typst") is True
                          and engine_flags.get("d2") is True and engine_flags.get("plantuml") is True,
                          f"Packaged export/diagram engines are unavailable: {engine_status!r}")

            print("Exporting a native note through the UI's rendered HTML and SVG asset pipeline", flush=True)
            search_for(client, "Native export pipeline")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] [aria-label=\\\"Open note: export.md\\\"]')", "export note result")
            click(client, client.find("[aria-label='Workspace'] [aria-label='Open note: export.md']"))
            smoke.wait_for_active_tab(client, "export.md")
            wait_preview(client)
            smoke.wait_for(client, "document.querySelector('.preview-pane .diagram svg')", "source Mermaid SVG before export")
            click(client, smoke.button(client, "Export"))
            export_panel = client.find("[aria-label='Export']")
            export_format = client.find("[aria-label='Export format']")
            client.element_command(export_format, "/click")
            client.send_keys(export_format, "pdf")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Export format\\\"]').value === 'pdf'", "PDF export selection")
            output_pdf = workspace / "native-ui-export.pdf"
            output_pdf.parent.mkdir(parents=True, exist_ok=True)
            click(client, client.find("//section[@aria-label='Export']//button[normalize-space(.)='Export document']", using="xpath"))
            dialogs.save_file(output_pdf, data)
            try:
                smoke.wait_for(client, "(() => { const panel=document.querySelector('[aria-label=\\\"Export\\\"]'); return Boolean(panel?.querySelector('.panel-status')?.innerText.includes('Exported native-ui-export.pdf') || panel?.querySelector('[role=\\\"alert\\\"]')); })()", "native UI PDF export success or error", timeout=60)
                export_error = client.execute("return document.querySelector('[aria-label=\\\"Export\\\"] [role=\\\"alert\\\"]')?.innerText || ''")
                if export_error:
                    raise AssertionError(f"Native UI PDF export returned an alert: {export_error}")
            except AssertionError as error:
                state = client.execute("return {panel:document.querySelector('[aria-label=\\\"Export\\\"]')?.innerText,alert:document.querySelector('[aria-label=\\\"Export\\\"] [role=\\\"alert\\\"]')?.innerText,format:document.querySelector('[aria-label=\\\"Export format\\\"]')?.value,busy:Array.from(document.querySelectorAll('[aria-label=\\\"Export\\\"] button')).find(e=>e.innerText.includes('Rendering'))?.innerText,hiddenHosts:Array.from(document.querySelectorAll('.markdown-body[aria-hidden=\\\"true\\\"]')).map(e=>({connected:e.isConnected,text:e.innerText,html:e.innerHTML.slice(0,2400),svg:e.querySelectorAll('svg').length,math:e.querySelectorAll('.katex').length,diagrams:Array.from(e.querySelectorAll('[data-diagram],[data-advanced-index]')).map(d=>({tag:d.tagName,busy:d.getAttribute('aria-busy'),html:d.innerHTML.slice(0,400)}))})),sandbox:document.querySelectorAll('.mermaid-sandbox').length,resources:performance.getEntriesByType('resource').map(e=>e.name).filter(n=>/mermaid|katex|woff|fonts/u.test(n)).slice(-30)}")
                screenshot = Path(__file__).resolve().parents[2] / "test-results" / "notation-export-ui-failure.png"
                screenshot.parent.mkdir(parents=True, exist_ok=True)
                client.screenshot(screenshot)
                raise AssertionError(f"{error}; export UI state={state!r}; output exists={output_pdf.exists()}; screenshot={screenshot}") from error
            smoke.require(output_pdf.is_file() and output_pdf.read_bytes().startswith(b"%PDF-"),
                          "Native UI did not create a valid PDF")
            extracted = subprocess.run(["pdftotext", str(output_pdf), "-"], check=True, capture_output=True, text=True).stdout
            smoke.require("Native export pipeline" in extracted and "Offline row" in extracted and "preserved" in extracted,
                          f"UI-exported PDF omitted note/table content: {extracted!r}")
            smoke.require((workspace / "export.md").read_text(encoding="utf-8") == export_text,
                          "PDF export changed the source Markdown file")
            print("Embedding the generated PDF with the packaged PDF.js worker", flush=True)
            search_for(client, "PDF workspace embed")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] [aria-label=\\\"Open note: pdf-embed.md\\\"]')", "PDF embed note result")
            click(client, client.find("[aria-label='Workspace'] [aria-label='Open note: pdf-embed.md']"))
            smoke.wait_for_active_tab(client, "pdf-embed.md")
            wait_preview(client)
            smoke.wait_for(client, "document.querySelector('.preview-pane [aria-label=\\\"Media: native-ui-export.pdf\\\"] canvas[aria-label=\\\"PDF page\\\"]')", "rendered native PDF page")
            smoke.wait_for(client, "document.querySelector('.preview-pane [aria-label=\\\"Media: native-ui-export.pdf\\\"] .pdf-controls span')?.innerText === 'Page 1 of 1'", "PDF.js page render complete")
            smoke.require((workspace / "pdf-embed.md").read_text(encoding="utf-8") == pdf_embed_text,
                          "Rendering the PDF embed changed its Markdown source")
            visual_pdf = Path(__file__).resolve().parents[2] / "test-results" / "notation-export.pdf"
            visual_pdf.parent.mkdir(parents=True, exist_ok=True)
            visual_pdf.write_bytes(output_pdf.read_bytes())
            print(f"Rendered PDF copied to {visual_pdf}", flush=True)

            print("Exercising bundled DOCX/PPTX/PDF converter commands", flush=True)
            export_root = root / "exports"
            export_root.mkdir(exist_ok=True)
            export_html = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Native conversion smoke</title></head><body><h1>Native conversion smoke</h1><p>Offline output content.</p></body></html>"
            outputs: dict[str, Path] = {}
            for format_name in ("pdf", "docx", "pptx"):
                output_path = export_root / f"native-smoke.{format_name}"
                result = invoke_native(client, "export_document", {"request": {
                    "id": str(uuid.uuid4()), "content": export_html, "inputFormat": "html",
                    "format": format_name, "outputPath": str(output_path), "title": "Native conversion smoke",
                }})
                smoke.require(output_path.is_file() and output_path.stat().st_size > 0,
                              f"{format_name.upper()} conversion did not create output: {result!r}")
                outputs[format_name] = output_path
            pdf_header = outputs["pdf"].read_bytes()[:8]
            smoke.require(pdf_header.startswith(b"%PDF-"), f"PDF output has an invalid signature: {pdf_header!r}")
            for format_name in ("docx", "pptx"):
                with zipfile.ZipFile(outputs[format_name]) as archive:
                    xml_paths = [name for name in archive.namelist() if name.endswith(".xml") and ("document" in name or "slide" in name)]
                    body = " ".join(archive.read(name).decode("utf-8", errors="replace") for name in xml_paths)
                    smoke.require("Native conversion smoke" in body and "Offline output content." in body,
                                  f"{format_name.upper()} output omitted converted document text")
            pdftotext = shutil.which("pdftotext")
            if pdftotext:
                extracted = subprocess.run([pdftotext, str(outputs["pdf"]), "-"], check=True, capture_output=True, text=True).stdout
                smoke.require("Native conversion smoke" in extracted and "Offline output content." in extracted,
                              f"PDF conversion omitted text: {extracted!r}")

            print("Opening filtered graph and following a workspace edge", flush=True)
            click(client, smoke.button(client, "Note graph"))
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Note graph\\\"] [role=\\\"group\\\"][aria-label=\\\"Workspace note connections\\\"]')", "workspace graph")
            smoke.wait_for(client, "Array.from(document.querySelectorAll('[aria-label=\\\"Note graph\\\"] [role=\\\"button\\\"]')).some(e=>e.getAttribute('aria-label')==='Open graph note: Alpha')", "Alpha graph node")
            node_names = client.execute("return Array.from(document.querySelectorAll('[aria-label=\\\"Note graph\\\"] [role=\\\"button\\\"]')).map(e=>e.getAttribute('aria-label'))")
            smoke.require("Open graph note: Beta" in node_names, f"Graph omitted Beta node: {node_names!r}")
            tag = client.find("[aria-label='Graph tag filter']")
            client.element_command(tag, "/clear")
            client.send_keys(tag, "urgent")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Note graph\\\"] .panel-note[role=\\\"status\\\"]')?.innerText.startsWith('1 notes ·')", "graph tag filter")
            client.execute_async("const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(done));")
            client.screenshot(Path(__file__).resolve().parents[2] / 'test-results/notation-graph-native.png')
            graph_node = client.find("[aria-label='Note graph'] [aria-label='Open graph note: Alpha'] circle")
            click(client, graph_node)
            smoke.wait_for_active_tab(client, "Alpha.md")
            smoke.require((workspace / "Alpha.md").read_text(encoding="utf-8").startswith("---\ntitle: Alpha"),
                          "Graph navigation changed the source note")
            click(client, client.find("//section[@aria-label='Note graph']//button[normalize-space(.)='Clear graph filters']", using="xpath"))
            smoke.wait_for(client, "document.querySelector('[aria-label=\"Graph tag filter\"]').value === ''", "cleared graph tag")
            local = client.find("[aria-label='Local graph']")
            click(client, local)
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Note graph\\\"] .panel-note[role=\\\"status\\\"]')?.innerText.startsWith('2 notes ·')",
                           "one-hop local graph")
            depth = client.find("[aria-label='Graph depth']")
            client.element_command(depth, "/click")
            client.send_keys(depth, "2")
            smoke.wait_for(client, "Array.from(document.querySelectorAll('[aria-label=\\\"Note graph\\\"] [role=\\\"button\\\"]')).some(e=>e.getAttribute('aria-label')==='Open graph note: Beta')",
                           "Beta in local graph")
            click(client, client.find("[aria-label='Note graph'] [aria-label='Open graph note: Beta'] circle"))
            smoke.wait_for_active_tab(client, "Beta.md")

            print("Saving and undoing a native Canvas card", flush=True)
            click(client, smoke.button(client, "Explorer"))
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Explorer\\\"] [aria-label=\\\"Open file: board.canvas\\\"]')", "Canvas file in Explorer")
            click(client, client.find("[aria-label=\"Explorer\"] [aria-label=\"Open file: board.canvas\"]"))
            smoke.wait_for_active_tab(client, "board.canvas")
            board = client.find("[aria-label=\"Canvas board\"]")
            click(client, client.find("[aria-label='Canvas'] button[aria-label='Add card']"))
            click(client, client.find("//*[@role='menu' and @aria-label='Add card']//*[@role='menuitem' and normalize-space(.)='Add text card']", using="xpath"))
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Canvas inspector\\\"] [aria-label=\\\"Card text\\\"]')", "Canvas card inspector")
            label = client.find("[aria-label=\"Canvas inspector\"] [aria-label=\"Card label\"]")
            client.element_command(label, "/clear")
            client.send_keys(label, "Native card")
            card_text = client.find("[aria-label=\"Canvas inspector\"] [aria-label=\"Card text\"]")
            client.element_command(card_text, "/clear")
            client.send_keys(card_text, "Persisted canvas content")
            click(client, smoke.button(client, "Apply card"))
            smoke.require(canvas_path.read_text(encoding="utf-8") == canvas_original,
                          "Canvas editing wrote to disk before Save")
            click(client, smoke.button(client, "Save"))
            smoke.wait_for(client, "document.querySelector('.status-message')?.innerText.includes('Saved board.canvas')", "canvas saved")
            saved_canvas = json.loads(canvas_path.read_text(encoding="utf-8"))
            smoke.require(len(saved_canvas["nodes"]) == 1 and saved_canvas["nodes"][0]["label"] == "Native card"
                          and saved_canvas["nodes"][0]["text"] == "Persisted canvas content",
                          f"Saved Canvas JSON omitted the edited card: {saved_canvas!r}")
            screenshot = Path(__file__).resolve().parents[2] / "test-results" / "notation-advanced-native.png"
            screenshot.parent.mkdir(parents=True, exist_ok=True)
            client.execute_async("const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(done));")
            client.screenshot(screenshot)
            print(f"Advanced native screenshot saved to {screenshot}", flush=True)
            client.execute("document.querySelector('[aria-label=\"Canvas board\"]').focus()")
            client.send_keys(board, "\ue009z\ue000")
            smoke.wait_for(client, "document.querySelector('[aria-label=\"Canvas card: New card\"]')", "canvas Undo restored the previous card")
            client.send_keys(board, "\ue009z\ue000")
            smoke.wait_for(client, "Array.from(document.querySelectorAll('[aria-label=Canvas] article[aria-label]')).filter(e=>e.getAttribute('aria-label').startsWith('Canvas card:')).length === 0", "canvas Undo restored empty board")
            click(client, smoke.button(client, "Save"))
            smoke.wait_for(client, "document.querySelector('.status-message')?.innerText.includes('Saved board.canvas')", "undone canvas saved")
            smoke.require(canvas_path.read_text(encoding="utf-8") == canvas_original,
                          "Undo did not restore the original Canvas file bytes")

        finally:
            if client.session_id:
                try:
                    client.quit()
                except Exception:
                    pass
            if driver is not None and driver.poll() is None:
                os.killpg(driver.pid, signal.SIGTERM)
                try:
                    driver.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(driver.pid, signal.SIGKILL)
                    driver.wait(timeout=5)
            if driver_log is not None:
                driver_log.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=Path.home() / ".local/bin/notation",
                        help="absolute path to the packaged Tauri launcher")
    args = parser.parse_args()
    run(args.app.resolve())


if __name__ == "__main__":
    main()
