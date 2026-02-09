
import { RegexValidator } from './src/tool-filter/regex/regex-validator.js';

const validator = new RegexValidator();
const pattern = '^(a+)+$';
const result = validator.validate(pattern);
console.log(JSON.stringify(result, null, 2));
