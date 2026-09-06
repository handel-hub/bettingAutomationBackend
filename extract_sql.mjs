import fs from 'fs';

const content = fs.readFileSync('docs/backend-implementation-plan-frozen.md', 'utf8');
const blocks = [];
const regex = /```sql\n([\s\S]*?)```/g;
let match;
while ((match = regex.exec(content)) !== null) {
  blocks.push(match[1]);
}

fs.writeFileSync('migrations/001_initial_schema.sql', blocks.join('\n\n'));
console.log('Extracted SQL blocks:', blocks.length);
