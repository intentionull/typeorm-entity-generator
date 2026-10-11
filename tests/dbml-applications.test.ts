import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { applications } from './dbml-application-expectations.js';
import { expectSchema, physical } from './dbml-test-helpers.js';

const directory = 'tests/fixtures/applications';

test('DBML application fixture inventory has an independent oracle for every input', () => {
  assert.deepEqual(
    readdirSync(directory)
      .filter((name) => name.endsWith('.dbml'))
      .sort(),
    Object.keys(applications)
      .map((name) => `${name}.dbml`)
      .sort(),
  );
});

for (const [name, expected] of Object.entries(applications)) {
  test(`DBML application ${name} matches the complete handwritten physical schema`, () => {
    const input = readFileSync(`${directory}/${name}.dbml`, 'utf8');
    const result = expectSchema(input);
    assert.deepEqual(physical(result), expected);
    assert.deepEqual(
      expectSchema(input),
      result,
      'Repeated calls include deterministic locations.',
    );
  });
}
