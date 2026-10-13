import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=new URL('../',import.meta.url);
await mkdir(new URL('public/pdfjs/',root),{recursive:true});
for(const name of ['cmaps','standard_fonts','wasm','iccs','LICENSE'])await cp(fileURLToPath(new URL('node_modules/pdfjs-dist/'+name,root)),fileURLToPath(new URL('public/pdfjs/'+name,root)),{recursive:true});
