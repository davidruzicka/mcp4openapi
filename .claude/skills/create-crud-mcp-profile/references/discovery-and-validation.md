# Discovery And Validation Commands

Use these commands as a fast, repeatable sequence.

## 1. Inspect existing profile conventions

```bash
rg --files profiles/<api> profiles/youtrack profiles/github-security
cat profiles/youtrack/profile.json
cat profiles/github-security/profile.json
```

## 2. Inventory OpenAPI operations

```bash
rg -n "operationId:|^\s{2,}(get|post|put|patch|delete):|^\s*/" profiles/<api>/<spec-file>
```

```bash
node <<'NODE'
const fs=require('fs');
const yaml=require('yaml');
const doc=yaml.parse(fs.readFileSync('profiles/<api>/<spec-file>','utf8'));
for(const [p,obj] of Object.entries(doc.paths||{})){
  for(const m of ['get','post','put','patch','delete']){
    const op=obj[m];
    if(!op) continue;
    const params=(op.parameters||[]).map(pr=>`${pr.name}:${pr.in}${pr.required?':required':''}`);
    console.log(`${m.toUpperCase()} ${p} | ${op.operationId||'(no operationId)'} | params=[${params.join(', ')}]`);
  }
}
NODE
```

## 3. Detect required parameters by operation

```bash
node <<'NODE'
const fs=require('fs');
const yaml=require('yaml');
const doc=yaml.parse(fs.readFileSync('profiles/<api>/<spec-file>','utf8'));
const map = new Map();
for(const pathObj of Object.values(doc.paths||{})){
  for(const method of ['get','post','put','patch','delete']){
    const op=pathObj[method];
    if(!op) continue;
    for(const p of (op.parameters||[])){
      if(!map.has(p.name)) map.set(p.name,{requiredBy:new Set(),optionalBy:new Set()});
      (p.required ? map.get(p.name).requiredBy : map.get(p.name).optionalBy).add(op.operationId);
    }
  }
}
for(const [name,v] of [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0]))){
  console.log(name);
  console.log('  requiredBy:', [...v.requiredBy].join(', '));
  console.log('  optionalBy:', [...v.optionalBy].join(', '));
}
NODE
```

## 4. Validate profile and run tests

```bash
npm run validate -- profiles/<api>/profile.json profiles/<api>/<spec-file>
npm run test:unit -- src/testing/generic-profile.test.ts
npm run typecheck
```

## 5. OpenAPI sanity fixes (example)

If parser throws errors like `Cannot use 'in' operator to search for '$ref' in string`, inspect invalid schema shortcuts such as:

```yaml
items: string
```

and replace with valid OpenAPI shape:

```yaml
items:
  type: string
```
