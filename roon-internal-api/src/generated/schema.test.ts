import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { structSchema } from './struct-schemas';
import { buildStruct } from '../proto/structs';
import { RemotingClient } from '../proto/remoting';

const root = path.resolve(__dirname, '../..');

test('compiled schemas use complete wire names and explicit captured collection overrides', () => {
  expect(structSchema('Sooloos.Broker.Api.SearchParameters')?.map((m) => m.name)).toEqual([
    'System.Sooid Sooloos.Broker.Api.SearchParameters::ProfileId',
    'string Sooloos.Broker.Api.SearchParameters::Terms',
    'int Sooloos.Broker.Api.SearchParameters::MaxCount',
    'bool Sooloos.Broker.Api.SearchParameters::IncludeHidden',
    'string Sooloos.Broker.Api.SearchParameters::CancelKey',
    'bool Sooloos.Broker.Api.SearchParameters::IsInstantSearch',
    'int Sooloos.Broker.Api.SearchParameters::MaxTopResultCount',
    'int Sooloos.Broker.Api.SearchParameters::RequestTimeoutInMs',
  ]);
  expect(structSchema('Sooloos.Broker.Api.LibraryEdit')?.find((m) => m.shortName === 'Albums')?.propType).toBe(24);
  expect(structSchema('Sooloos.Broker.Api.EditList<string>')?.find((m) => m.shortName === 'AddValues')?.propType).toBe(24);
  expect(structSchema('Sooloos.Broker.Api.EditRequiredRef<string>')?.find((m) => m.shortName === 'EditValue')?.propType).toBe(20);
  expect(structSchema('Sooloos.Broker.Api.EditOptionalVal<int>')?.find((m) => m.shortName === 'EditValue')?.propType).toBe(10);
  expect(structSchema('Vendor.Unknown')).toBeUndefined();
  expect(structSchema('toString')).toBeUndefined();
});

test('regeneration is deterministic and normalizes only the evidenced metadata namespace', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'roon-schemas-'));
  try {
    fs.mkdirSync(path.join(temp, 'tools'));
    fs.mkdirSync(path.join(temp, 'src/catalog'), { recursive: true });
    fs.copyFileSync(path.join(root, 'tools/gen_client.ts'), path.join(temp, 'tools/gen_client.ts'));
    const original = fs.readFileSync(path.join(root, 'src/catalog/catalog.authoritative.json'), 'utf8');
    const catalogPath = path.join(temp, 'src/catalog/catalog.authoritative.json');
    fs.writeFileSync(catalogPath, original);
    const generate = () => execFileSync(process.execPath, [
      require.resolve('ts-node/dist/bin.js'), '--transpile-only', '--compiler-options',
      JSON.stringify({ module: 'commonjs', moduleResolution: 'node' }), path.join(temp, 'tools/gen_client.ts'),
    ], { cwd: root, stdio: 'pipe' });
    generate();
    for (const file of ['src/generated/api.ts', 'src/generated/struct-schemas.ts', 'docs/reflist-audit.md']) {
      expect(fs.readFileSync(path.join(temp, file), 'utf8')).toBe(fs.readFileSync(path.join(root, file), 'utf8'));
    }
    const alternate = JSON.parse(original.replace(/Sooloos\.Broker\.Api\./g, 'Roon.Broker.Api.'));
    alternate.source = 'Fixture Roon.Broker.Api.dll metadata';
    alternate.structs['Vendor.Unknown'] = { members: [{ name: 'Value', type: 'Roon.Unrelated.Value', propType: 23 }] };
    const fixture = JSON.stringify(alternate);
    fs.writeFileSync(catalogPath, fixture);
    generate();
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe(fixture);
    const api = fs.readFileSync(path.join(temp, 'src/generated/api.ts'), 'utf8');
    expect(api).not.toContain('Roon.Broker.Api.');
    expect(api).toContain('Sooloos.Broker.Api.Library::UnifiedSearch(');
    const schemas = fs.readFileSync(path.join(temp, 'src/generated/struct-schemas.ts'), 'utf8');
    expect(schemas).toContain('// Source: Fixture Roon.Broker.Api.dll metadata');
    expect(schemas).toContain('string Sooloos.Broker.Api.SearchParameters::Terms');
    expect(schemas).toContain('Roon.Unrelated.Value Vendor.Unknown::Value');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});


test('captured collection fields reject unsupported JS values before declaration', () => {
  const send = jest.fn();
  const remoting = new RemotingClient({ send, onData: () => {} });
  expect(() => buildStruct({ remoting }, 'Sooloos.Broker.Api.LibraryEdit', { Albums: [] }))
    .toThrow(/pre-serialized length-prefixed Buffer/);
  expect(send).not.toHaveBeenCalled();
});
