async (page) => {
  // Try multiple ways to get fs access in Node vm context
  let fs;
  try { fs = process.mainModule.require('fs'); } catch(e) {}
  if (!fs) try { fs = module.require('fs'); } catch(e) {}
  if (!fs) try { const m = require; fs = m('fs'); } catch(e) {}
  
  if (!fs) return 'Could not get fs module. Trying page.evaluate with hardcoded path...';
  
  const cuits = fs.readFileSync('/root/claude-code-bridge/cuits.txt', 'utf8').trim();
  const lines = cuits.split('\n');

  await page.evaluate((data) => {
    const ta = document.getElementById('textoImportacion');
    if (!ta) return;
    ta.value = data;
    ta.dispatchEvent(new Event('input', {bubbles: true}));
  }, cuits);

  const count = await page.evaluate(() => {
    const ta = document.getElementById('textoImportacion');
    return ta ? ta.value.split('\n').length : -1;
  });

  return 'Set ' + lines.length + ' CUITs. Verified ' + count + ' lines in textarea.';
}
