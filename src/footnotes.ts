import { featureParser, markdownSource } from './markdown-features';
export type Footnote = { id:string; from:number; to:number; body:string; mapping:number[] };
export function extractFootnotes(text:string, allowFrontmatter=true) {
  const source=markdownSource(text,allowFrontmatter), excluded:{from:number;to:number}[]=[];
  featureParser.parse(source).iterate({enter(node){if(['FencedCode','CodeBlock','InlineCode','HTMLBlock','HTMLTag','NotationMathBlock','NotationMathInline'].includes(node.name)){excluded.push({from:node.from,to:node.to});return false;}}});
  const lines:{text:string;from:number;to:number}[]=[];let offset=0;
  for(const line of text.split('\n')){lines.push({text:line,from:offset,to:offset+line.length});offset+=line.length+1;}
  const definitions:Footnote[]=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i], match=/^ {0,3}\[\^([A-Za-z0-9_-]{1,128})\]:[ \t]*(.*)\r?$/u.exec(line.text);
    if(!match||excluded.some(range=>line.from>=range.from&&line.from<range.to)||source.slice(line.from,line.to).trim()==='')continue;
    const prefix=line.text.indexOf(':')+1, bodyStart=prefix+(line.text.slice(prefix).match(/^[ \t]*/u)?.[0].length??0);
    let body=line.text.slice(bodyStart).replace(/\r$/u,''), end=i;const mapping:number[]=[];
    for(let j=0;j<body.length;j++)mapping.push(line.from+bodyStart+j);
    while(end+1<lines.length){
      const next=lines[end+1];
      const indent=/^(?: {4}|\t)/u.exec(next.text)?.[0].length;
      if(indent===undefined){
        if(!next.text.trim()&&end+2<lines.length&&/^(?: {4}|\t)/u.test(lines[end+2].text)){mapping.push(lines[end].to);body+='\n';end++;continue;}break;
      }
      mapping.push(lines[end].to);body+='\n';const value=next.text.slice(indent).replace(/\r$/u,'');for(let j=0;j<value.length;j++)mapping.push(next.from+indent+j);body+=value;end++;
    }
    mapping.push(lines[end].to);definitions.push({id:match[1],from:line.from,to:lines[end].to,body,mapping});i=end;
  }
  let masked=source;
  for(const definition of [...definitions].reverse())masked=masked.slice(0,definition.from)+masked.slice(definition.from,definition.to).replace(/[^\r\n]/g,' ')+masked.slice(definition.to);
  const references:{id:string;from:number;to:number}[]=[];
  for(const match of masked.matchAll(/\[\^([A-Za-z0-9_-]{1,128})\]/gu)){
    let slashes=0;for(let at=match.index-1;at>=0&&text[at]==='\\';at--)slashes++;
    if(slashes%2||excluded.some(range=>match.index>=range.from&&match.index<range.to))continue;
    references.push({id:match[1],from:match.index,to:match.index+match[0].length});
  }
  return {source:masked,definitions,references};
}
