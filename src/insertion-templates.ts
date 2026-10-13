export const insertionTemplates = [
  { key: 'heading', label: 'Heading', palette: 'Insert heading', text: '# Heading', caret: 2 },
  { key: 'task', alias: 'todo', label: 'Task list', palette: 'Insert task list', text: '- [ ] Task', caret: 6 },
  { key: 'mermaid', label: 'Mermaid', palette: 'Insert Mermaid', text: '```mermaid\nflowchart LR\n  A --> B\n```', caret: 11 },
  { key: 'dot', label: 'Graphviz', palette: 'Insert Graphviz', text: '```dot\ndigraph G {\n  Idea -> Note;\n}\n```', caret: 7 },
  { key: 'd2', label: 'D2', palette: 'Insert D2', text: '```d2\nIdea -> Note\n```', caret: 6 },
  { key: 'plantuml', label: 'PlantUML', palette: 'Insert PlantUML', text: '```plantuml\n@startuml\nAlice -> Bob: Hello\n@enduml\n```', caret: 12 },
  { key: 'math', label: 'Math', palette: 'Insert math equation', text: '$$\nx^2\n$$', caret: 3 },
  { key: 'cell', label: 'JavaScript cell', palette: 'Insert JavaScript cell', text: '```javascript cell:example\nreturn {value:42};\n```', caret: 27 },
  { key: 'query', label: 'Query', palette: 'Insert query', text: '```query\nview: table\ncolumns: [title, tags]\nlimit: 50\n```', caret: 9 },
  { key: 'table', label: 'Table', palette: 'Insert table', text: '| Column | Column |\n| --- | --- |\n| Value | Value |', caret: 2 },
  { key: 'callout', label: 'Callout', palette: 'Insert callout', text: '> [!NOTE] Note\n> Write a note.', caret: 10 },
  { key: 'toggle', label: 'Toggle', palette: 'Insert toggle', text: '> [!NOTE]- Details\n> Hidden details.', caret: 11 },
  { key: 'code', label: 'Code block', palette: 'Insert code block', text: '```text\n\n```', caret: 8 },
  { key: 'divider', label: 'Divider', palette: 'Insert divider', text: '---', caret: 3 },
  { key: 'footnote', label: 'Footnote', palette: 'Insert footnote', text: 'Note[^note]\n\n[^note]: Footnote text.', caret: 4 },
  { key: 'citation', label: 'Citation', palette: 'Insert citation', text: '[@reference]', caret: 2 },
] as const;
export const insertionCommands = insertionTemplates.map(template => ({ id: ('insert.' + template.key) as `insert.${typeof template.key}`, label: template.palette, group: 'Insert', defaultShortcut: '' }));
