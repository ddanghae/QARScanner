import {report,reset} from '../tests/harness.js';
import {run} from '../tests/cup-handle.test.js';
reset();run();
const result=report();
for(const line of result.lines)console.log(line);
console.log(result.summary);
process.exit(result.fail?1:0);
