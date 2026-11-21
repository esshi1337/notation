import { test, expect } from '@playwright/test';
import { runCommand, openSettings } from './commands';
const source=(page:any)=>page.getByRole('textbox',{name:'Document source'}).filter({visible:true});
test('code files preserve filenames, source layout, highlighting, comments, folding and language override',async({page})=>{
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({name:'main.ts',mimeType:'text/plain',buffer:Buffer.from('function greet(name: string) {\n  return "Hi " + name;\n}\n')});
  await expect(page.getByRole('tab',{name:'main.ts',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('region',{name:'Preview pane'})).toBeHidden();
  await expect(page.getByRole('button',{name:'Change document language',exact:true})).toHaveText('TypeScript');
  await expect(page.getByRole('combobox',{name:'Language',exact:true})).toHaveCount(0);
  await expect(source(page).locator('span').filter({hasText:/^function$/})).toBeVisible();
  await source(page).click();await page.keyboard.press('ControlOrMeta+Home');
  await runCommand(page,'Toggle line comment');await expect(source(page)).toContainText('// function greet');
  await runCommand(page,'Undo');
  await runCommand(page,'Fold all');await expect(page.locator('.cm-foldPlaceholder:visible')).toHaveCount(1);
  await runCommand(page,'Unfold all');await expect(page.locator('.cm-foldPlaceholder:visible')).toHaveCount(0);
  const download=page.waitForEvent('download');await runCommand(page,'Save As');expect((await download).suggestedFilename()).toBe('main.ts');
  await runCommand(page,'Change document language');
  await page.getByRole('combobox',{name:'Language',exact:true}).click();await page.getByRole('option',{name:'Rust',exact:true}).click();
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.reload();await expect(page.getByRole('button',{name:'Change document language',exact:true})).toHaveText('Rust · override');
});
test('file navigation and search find unsaved code buffers; indentation preferences persist',async({page})=>{
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({name:'App.svelte',mimeType:'text/plain',buffer:Buffer.from('<script>\nlet count = 0;\n</script>')});
  await runCommand(page,'Go to file');await page.getByRole('textbox',{name:'File name'}).fill('App.svelte');await page.getByRole('textbox',{name:'File name'}).press('Enter');
  await expect(page.getByRole('dialog',{name:'Go to file'})).toBeHidden();
  await runCommand(page,'Search workspace files');await page.getByRole('textbox',{name:'Search text',exact:true}).fill('count');await page.getByRole('button',{name:'Search',exact:true}).click();
  await expect(page.getByRole('button').filter({hasText:'App.svelte:2'})).toBeVisible();await page.getByRole('button').filter({hasText:'App.svelte:2'}).click();
  await openSettings(page);await page.getByRole('tab',{name:'Editor',exact:true}).click();
  await page.getByRole('checkbox',{name:'Indent with tabs',exact:true}).check();await page.getByRole('checkbox',{name:'Language intelligence',exact:true}).uncheck();
  await page.reload();await openSettings(page);await page.getByRole('tab',{name:'Editor',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:'Indent with tabs',exact:true})).toBeChecked();await expect(page.getByRole('checkbox',{name:'Language intelligence',exact:true})).not.toBeChecked();
});
test('code buffers stay usable with many tabs and a large source file',async({page},testInfo)=>{
  test.setTimeout(90000);await page.goto('/');
  const started=Date.now();
  for(let index=0;index<20;index++)await page.locator('input[type=file]').setInputFiles({name:`module-${index}.ts`,mimeType:'text/plain',buffer:Buffer.from(`export const value${index} = ${index};\n`)});
  const content=Array.from({length:20000},(_,index)=>`export const row${index} = ${index};`).join('\n');
  const largeStart=Date.now();await page.locator('input[type=file]').setInputFiles({name:'large.ts',mimeType:'text/plain',buffer:Buffer.from(content)});
  await expect(page.getByRole('tab',{name:'large.ts',exact:true})).toHaveAttribute('aria-selected','true');
  const largeOpenMs=Date.now()-largeStart;
  await source(page).click();await page.keyboard.press('ControlOrMeta+Home');const typing=Date.now();await page.keyboard.type('// edited\n');await expect(source(page)).toContainText('// edited');const typingMs=Date.now()-typing;
  const session=await page.context().newCDPSession(page);await session.send('Performance.enable');
  const before=await session.send('Performance.getMetrics');await page.waitForTimeout(2000);const after=await session.send('Performance.getMetrics');
  const value=(metrics:any,name:string)=>metrics.metrics.find((item:any)=>item.name===name)?.value??0;
  const measurements={tabs:22,largeLines:20000,largeBytes:Buffer.byteLength(content),largeOpenMs,typingMs,totalMs:Date.now()-started,idleTaskSeconds:value(after,'TaskDuration')-value(before,'TaskDuration'),jsHeapBytes:value(after,'JSHeapUsedSize'),mountedEditors:await page.locator('.cm-editor').count()};
  await testInfo.attach('code-performance-baseline',{body:JSON.stringify(measurements,null,2),contentType:'application/json'});
  console.log('CODE_PERFORMANCE '+JSON.stringify(measurements));
  await page.screenshot({path:testInfo.outputPath('code-editor.png')});
});

test('Markdown defaults and extension routing do not load language intelligence; overrides remain secondary',async({page})=>{
  const requested:string[]=[];page.on('request',request=>requested.push(request.url()));
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Change document language',exact:true})).toHaveText('Markdown');
  expect(requested.some(url=>url.includes('/src/code-syntax') || url.includes('/src/language-intelligence'))).toBe(false);
  await page.evaluate(()=>localStorage.setItem('notation.settings',JSON.stringify({languageIntelligence:true,layout:'preview'})));
  await page.reload();
  await openSettings(page);await page.getByRole('tab',{name:'Editor',exact:true}).click();
  const intelligence=page.getByRole('checkbox',{name:'Language intelligence',exact:true});
  await expect(intelligence).not.toBeChecked();
  await intelligence.check();await page.reload();await openSettings(page);await page.getByRole('tab',{name:'Editor',exact:true}).click();
  await expect(intelligence).toBeChecked();await intelligence.uncheck();await page.keyboard.press('Escape');
  for (const [name,language] of [['notes.md','Markdown'],['readme.txt','Plain text'],['main.ts','TypeScript'],['App.svelte','Svelte'],['main.rs','Rust']]) {
    await page.locator('input[type=file]').setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from('# test\n')});
    await expect(page.getByRole('button',{name:'Change document language',exact:true})).toHaveText(language);
    if(name.endsWith('.md'))await expect(page.getByRole('region',{name:'Preview pane'})).toBeVisible();
    else await expect(page.getByRole('region',{name:'Preview pane'})).toBeHidden();
  }
  expect(requested.some(url=>url.includes('/src/language-intelligence'))).toBe(false);
  await page.getByRole('button',{name:'Change document language',exact:true}).click();
  await page.getByRole('combobox',{name:'Language',exact:true}).click();await page.getByRole('option',{name:'Markdown',exact:true}).click();
  await page.getByRole('button',{name:'Done',exact:true}).click();await expect(page.getByRole('region',{name:'Preview pane'})).toBeVisible();
  await runCommand(page,'Change document language');await page.getByRole('combobox',{name:'Language',exact:true}).click();await page.getByRole('option',{name:'Automatic · Rust',exact:true}).click();
  await page.keyboard.press('Escape');await expect(page.getByRole('region',{name:'Preview pane'})).toBeHidden();
  await runCommand(page,'New');await expect(page.getByRole('button',{name:'Change document language',exact:true})).toHaveText('Markdown');
});
