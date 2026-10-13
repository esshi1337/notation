import { parseFrontmatter } from './frontmatter';
export type PropertyFilter = { key: string; op: 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'contains'|'exists'; value?: unknown };
export type SearchRequest = { text?: string; folder?: string; tags?: string[]; tagMode?: 'all'|'any'; properties?: PropertyFilter[]; sort?: 'relevance'|'title'|'path'; sortProperty?: string; descending?: boolean; limit?: number; offset?: number };
export type QueryView = { view: 'table'|'list'; columns: string[]; request: SearchRequest };
export type QueryNote = { path: string; name: string; title: string; tags: string[]; properties: Record<string, unknown>; snippet?: string };
export type QueryResult = { results: QueryNote[]; total: number; hasMore: boolean; nextOffset: number|null };
export function parseQuery(text: string): QueryView {
  const parsed = parseFrontmatter('---\n' + text + '\n---');
  if (!parsed || parsed.error) throw new Error(parsed?.error || 'Invalid YAML query.');
  const data = parsed.values;
  const supported = new Set(['view','columns','text','folder','tags','tagMode','where','sort','limit']);
  for (const key of Object.keys(data)) if (!supported.has(key)) throw new Error('Unknown query option: ' + key);
  const view = data.view ?? 'table'; if (view !== 'table' && view !== 'list') throw new Error('view must be table or list.');
  const columns = data.columns ?? ['title','tags'];
  if (!Array.isArray(columns) || columns.length > 16 || !columns.length || columns.some(value => typeof value !== 'string' || !value.trim())) throw new Error('columns must contain 1–16 property names.');
  const request: SearchRequest = { limit: 50, sort: 'title' };
  for (const key of ['text','folder'] as const) { if (data[key] !== undefined) { if (typeof data[key] !== 'string') throw new Error(key + ' must be text.'); request[key] = data[key]; } }
  if (data.tags !== undefined) { if (!Array.isArray(data.tags) || data.tags.some(tag => typeof tag !== 'string')) throw new Error('tags must be a list of names.'); request.tags = data.tags; }
  if (data.tagMode !== undefined) { if (data.tagMode !== 'all' && data.tagMode !== 'any') throw new Error('tagMode must be all or any.'); request.tagMode = data.tagMode; }
  if (data.where !== undefined) {
    if (!Array.isArray(data.where) || data.where.length > 32) throw new Error('where must be a list of up to 32 filters.');
    request.properties = data.where.map(item => {
      if (!item || typeof item !== 'object' || typeof item.key !== 'string' || !item.key.trim() || !['eq','ne','gt','gte','lt','lte','contains','exists'].includes(item.op)) throw new Error('Each filter needs key, op, and value (except exists).');
      if (item.op !== 'exists' && !Object.hasOwn(item, 'value')) throw new Error('Missing value for ' + item.key);
      return { key: item.key, op: item.op, ...(Object.hasOwn(item,'value') ? {value:item.value} : {}) } as PropertyFilter;
    });
  }
  if (data.limit !== undefined) { if (!Number.isInteger(data.limit) || Number(data.limit) < 1 || Number(data.limit) > 200) throw new Error('limit must be 1–200.'); request.limit = Number(data.limit); }
  if (data.sort !== undefined) {
    const sort = typeof data.sort === 'string' ? { by: data.sort, direction: 'asc' } : data.sort;
    if (!sort || typeof sort !== 'object' || !('by' in sort) || typeof sort.by !== 'string' || !sort.by || ('direction' in sort && !['asc','desc'].includes(String(sort.direction)))) throw new Error('sort needs by and direction: asc or desc.');
    if (['title','path','relevance'].includes(sort.by)) request.sort = sort.by as SearchRequest['sort']; else request.sortProperty = sort.by;
    request.descending = 'direction' in sort && sort.direction === 'desc';
  }
  return { view, columns: columns as string[], request };
}
export function queryValue(note: QueryNote, column: string): string {
  const value = column === 'title' ? note.title || note.name : column === 'path' ? note.path : column === 'tags' ? note.tags : note.properties[column];
  return value === undefined || value === null ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
}
