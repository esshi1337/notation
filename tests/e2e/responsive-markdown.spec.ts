import { expect, test } from '@playwright/test';
import { runCommand } from './commands';

const paragraph = 'Text should wrap within the available pane as the window changes size. '.repeat(5);
const longToken = 'abcdefghij'.repeat(30);
const columns = Array.from({ length: 14 }, (_, index) => `Column ${index + 1}`);
const wideTable = [columns, columns.map(() => '---'), columns.map(() => 'A readable value')]
  .map(row => `| ${row.join(' | ')} |`).join('\n');

test('enabling saved word wrap contains a long unbroken Live Preview line after resizing and reload', async ({ page }, testInfo) => {
  await page.goto('/');
  const source = page.getByRole('textbox', { name: 'Document source' });
  const text = 'Hdsfl;sdjflsdjfsdjl;fjsdl;jgl;dsgkj1111' + 'k'.repeat(280) + ';end';
  await source.fill(text);
  await runCommand(page, 'Live Preview');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await runCommand(page, 'Settings');
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  await settings.getByRole('checkbox', { name: 'Word wrap', exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(source).not.toHaveClass(/cm-lineWrapping/);
  expect(await page.locator('.cm-scroller').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);

  await runCommand(page, 'Settings');
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  await settings.getByRole('checkbox', { name: 'Word wrap', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(source).toHaveClass(/cm-lineWrapping/);
  for (const width of [1200, 720, 480, 1200]) {
    await page.setViewportSize({ width, height: 700 });
    await expect.poll(() => source.evaluate(element => {
      const scroller = element.closest('.cm-scroller')!;
      const line = element.querySelector('.cm-line')!;
      const range = document.createRange();
      range.selectNodeContents(line);
      const text = range.getBoundingClientRect(), box = element.getBoundingClientRect();
      return scroller.scrollWidth <= scroller.clientWidth + 1
        && text.height > parseFloat(getComputedStyle(line).lineHeight)
        && text.left >= box.left && text.right <= box.right;
    })).toBe(true);
    await expect(source).toHaveText(text);
  }
  await page.reload();
  await expect(source).toHaveClass(/cm-lineWrapping/);
  await expect(source).toHaveText(text);
  await page.screenshot({ path: testInfo.outputPath('long-line-wrapped.png') });
});

test('split text stays within equal panes when a wide table is present and the window resizes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Document source' }).fill(
    `# Responsive document\n\n${paragraph}\n\n${longToken}\n\n${wideTable}\n\nText after the table.`,
  );
  await runCommand(page, 'Split');
  await expect(page.locator('.preview-scroll table')).toBeVisible();

  for (const width of [1440, 1000, 720, 480, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => {
      const source = document.querySelector<HTMLElement>('.source-pane')!;
      const preview = document.querySelector<HTMLElement>('.preview-pane')!;
      const containers = [...document.querySelectorAll<HTMLElement>('.cm-scroller, .preview-scroll, .preview-scroll > .markdown-body')];
      return {
        equalPanes: Math.abs(source.clientWidth - preview.clientWidth) <= 1,
        contained: containers.every(element => element.scrollWidth <= element.clientWidth + 1),
        pageContained: document.documentElement.scrollWidth <= innerWidth,
      };
    })).toEqual({ equalPanes: true, contained: true, pageContained: true });
  }
});

for (const mode of ['Split', 'Live Preview']) {
  test(`${mode} keeps table columns readable and scrolls wide tables independently`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Document source' }).fill(
      `# Tables\n\nText before the tables.\n\n| Project | Description | Status |\n| --- | :---: | ---: |\n| Notation | ${paragraph} ${longToken} | Ready |\n\n${wideTable}\n\nText after the tables.`,
    );
    await runCommand(page, mode);
    const root = page.locator(mode === 'Split' ? '.preview-scroll' : '.cm-content');
    const tables = root.locator('table');
    await expect(tables).toHaveCount(2);
    const first = tables.first();
    // Short headings must not collapse into a vertical stack of letters.
    expect(await first.locator('th').first().evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().height <= parseFloat(getComputedStyle(element).lineHeight);
    })).toBe(true);
    const widths = await first.evaluate(table => {
      const header = [...table.querySelectorAll('th')];
      const cells = [...table.querySelectorAll('tbody tr:first-child td')];
      return header.map((cell, index) => Math.abs(cell.getBoundingClientRect().width - cells[index].getBoundingClientRect().width));
    });
    expect(widths.every(delta => delta <= 1)).toBe(true);
    await expect(first.locator('th').nth(1)).toHaveCSS('text-align', 'center');
    await expect(first.locator('td').nth(2)).toHaveCSS('text-align', 'right');

    const scroll = root.getByRole('region', { name: 'Markdown table', exact: true }).last();
    await expect(scroll).toBeVisible();
    expect(await scroll.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await scroll.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    expect(await root.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await scroll.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await expect(scroll.getByRole('columnheader', { name: 'Column 14', exact: true })).toBeInViewport();
    for (const width of [1000, 480, 720]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => root.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await root.evaluate(element => {
      const scroller = element.closest('.cm-scroller') ?? element;
      scroller.scrollTop = 0;
      for (const table of element.querySelectorAll('.markdown-table-scroll')) table.scrollLeft = 0;
    });
    await page.screenshot({ path: testInfo.outputPath('responsive-tables.png') });
  });
}
