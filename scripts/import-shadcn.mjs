// Import the official MIT-licensed Base UI registry sources with local aliases.
import { mkdir, writeFile } from 'node:fs/promises';
const names = [
  'button',
  'input',
  'textarea',
  'label',
  'checkbox',
  'select',
  'dialog',
  'alert-dialog',
  'popover',
  'dropdown-menu',
  'context-menu',
  'tabs',
  'collapsible',
  'tooltip',
  'badge',
  'alert',
  'table',
  'breadcrumb',
  'separator',
  'resizable',
  'combobox',
  'input-group',
  'scroll-area',
  'switch',
];
await mkdir('src/renderer/src/components/ui', { recursive: true });
const imported = [];
for (const name of names) {
  const url = `https://ui.shadcn.com/r/styles/base-nova/${name}.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  const item = await response.json();
  for (const file of item.files) {
    if (!file.path.endsWith('.tsx')) continue;
    const icons = new Set();
    let content = file.content
      .replace(/import \{ IconPlaceholder \} from [^\n]+\n/g, '')
      .replace(/<IconPlaceholder\s+([\s\S]*?)\/>/g, (_, attrs) => {
        const icon = attrs.match(/lucide="([^"]+)"/)?.[1];
        if (!icon) throw new Error(`Missing icon: ${name}`);
        icons.add(icon);
        return `<${icon} ${attrs.replace(/(?:lucide|tabler|hugeicons|phosphor|remix|remixicon)="[^"]*"\s*/g, '')}/>`;
      })
      .replace(/from "cn"/g, 'from "../../lib/utils"')
      .replace(/@\/registry\/base-nova\/ui\//g, './');
    if (icons.size) content = `import { ${[...icons].join(', ')} } from "lucide-react"\n${content}`;
    content = `// shadcn/ui base-nova (MIT). Source: ${url}\n${content}`;
    await writeFile(`src/renderer/src/components/ui/${name}.tsx`, content);
  }
  imported.push({
    name,
    url,
    dependencies: item.dependencies,
    registryDependencies: item.registryDependencies,
  });
}
await mkdir('licenses', { recursive: true });
await writeFile('licenses/shadcn-registry.json', JSON.stringify(imported, null, 2) + '\n');
console.log(`Imported ${imported.length} official Base UI components.`);
