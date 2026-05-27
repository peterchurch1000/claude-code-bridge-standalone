async (page) => {
  const { readFileSync } = await import('fs');
  const cuits = readFileSync('/root/claude-code-bridge/cuits.txt', 'utf8').trim();

  await page.evaluate((data) => {
    const ta = document.getElementById('textoImportacion');
    ta.value = data;
    ta.dispatchEvent(new Event('input', {bubbles: true}));
  }, cuits);

  const count = await page.evaluate(() => document.getElementById('textoImportacion').value.split('\n').length);
  return 'Done: ' + count + ' lines set in textarea';
}
