const test = require('node:test');
const assert = require('node:assert/strict');

const { DumpspaceSession, normalizeDumpJson } = require('../src/core/dumpspaceSession');

const fixture = {
  classes: {
    UObject: [
      { __MDKClassSize: [0, 0x28] },
      { Name: [['FName', 'S'], 0x18, 0x8] }
    ],
    AActor: [
      { __InheritInfo: ['UObject'] },
      { RootComponent: [['USceneComponent', 'C', '*'], 0x130, 0x8] }
    ],
    ACharacter: [
      { __InheritInfo: ['AActor'] },
      { Mesh: [['USkeletalMesh', 'C', '*'], 0x328, 0x8] },
      { HealthState: [['EHealthState', 'E'], 0x730, 0x1] }
    ],
    ADBDPlayer: [
      { __InheritInfo: ['ACharacter'] },
      { HealthComponent: [['UHealthComponent', 'C', '*'], 0x780, 0x8] },
      { InteractionHandler: [['UInteractionHandler', 'C', '*'], 0x788, 0x8] }
    ]
  },
  structs: {
    FVector: [
      { X: [['float', 'D'], 0x0, 0x4] },
      { Y: [['float', 'D'], 0x4, 0x4] },
      { Z: [['float', 'D'], 0x8, 0x4] }
    ]
  },
  functions: {
    ADBDPlayer: {
      GetHealth: [['float', 'D'], [[['UHealthComponent', 'C', '*'], '', 'component']]]
    }
  },
  enums: {
    EHealthState: [
      { Healthy: 0 },
      { Injured: 1 }
    ]
  },
  offsets: {
    GWorld: 0x123456
  }
};

test('searchSymbols supports wildcard OR queries with paged results', () => {
  const session = new DumpspaceSession({ defaultLimit: 2, maxLimit: 3 });
  session.loadData(fixture);

  const firstPage = session.searchSymbols({ query: '*health*|A*', limit: 2 });

  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.page.limit, 2);
  assert.equal(typeof firstPage.page.nextCursor, 'string');
  assert.ok(firstPage.items.some((item) => item.name === 'AActor'));

  const secondPage = session.searchSymbols({
    query: '*health*|A*',
    cursor: firstPage.page.nextCursor,
    limit: 2
  });

  assert.ok(secondPage.items.length > 0);
  assert.notDeepEqual(
    secondPage.items.map((item) => item.id),
    firstPage.items.map((item) => item.id)
  );
});

test('searchMembers can include inherited members and type wildcard matches', () => {
  const session = new DumpspaceSession();
  session.loadData(fixture);

  const result = session.searchMembers({
    owner: 'ADBDPlayer',
    query: '*component*',
    includeInherited: true,
    searchFields: ['name', 'type'],
    limit: 10
  });

  assert.deepEqual(
    result.items.map((item) => `${item.owner}.${item.name}`),
    ['AActor.RootComponent', 'ADBDPlayer.HealthComponent']
  );
});

test('explainTypeRelationship reports inheritance paths and compatibility', () => {
  const session = new DumpspaceSession();
  session.loadData(fixture);

  const upcast = session.explainTypeRelationship({
    from: 'ADBDPlayer',
    to: 'UObject'
  });
  assert.equal(upcast.compatible, true);
  assert.equal(upcast.relationship, 'derived-to-base');
  assert.deepEqual(upcast.path, ['ADBDPlayer', 'ACharacter', 'AActor', 'UObject']);

  const downcast = session.explainTypeRelationship({
    from: 'UObject',
    to: 'ADBDPlayer'
  });
  assert.equal(downcast.compatible, true);
  assert.equal(downcast.relationship, 'base-to-derived');
});

test('normalizeDumpJson unwraps Dumpspace export wrappers into keyed maps', () => {
  // Classes/Structs/Functions/Enums: array of single-key objects.
  const classesWrapper = {
    version: '1.0',
    updated_at: '2026-01-01',
    data: [
      { UObject: [{ __InheritInfo: [] }] },
      { AActor: [{ __InheritInfo: ['UObject'] }] }
    ]
  };
  const classes = normalizeDumpJson(classesWrapper);
  assert.deepEqual(Object.keys(classes), ['UObject', 'AActor']);
  assert.deepEqual(classes.AActor, [{ __InheritInfo: ['UObject'] }]);

  // Offsets: array of [name, value] pairs, NOT single-key objects.
  const offsetsWrapper = {
    version: '1.0',
    credit: 'x',
    data: [
      ['OFFSET_GWORLD', 0x123456],
      ['INDEX_PROCESSEVENT', 76]
    ]
  };
  const offsets = normalizeDumpJson(offsetsWrapper);
  assert.deepEqual(offsets, { OFFSET_GWORLD: 0x123456, INDEX_PROCESSEVENT: 76 });

  // Native/direct keyed format passes through unchanged.
  const native = { UObject: [{ __InheritInfo: [] }] };
  assert.equal(normalizeDumpJson(native), native);

  // Garbage is coerced to an empty object.
  assert.deepEqual(normalizeDumpJson(null), {});
});

test('a loaded wrapper-format dump exposes symbols and offsets', () => {
  const session = new DumpspaceSession();
  session.loadData({
    classes: normalizeDumpJson({
      version: '1.0',
      data: [{ UHealthComponent: [{ __InheritInfo: ['UObject'] }] }]
    }),
    offsets: normalizeDumpJson({
      version: '1.0',
      data: [['OFFSET_GWORLD', 0xcebcea0]]
    })
  });

  const hit = session.searchSymbols({ query: 'UHealth*' });
  assert.ok(hit.items.some((item) => item.name === 'UHealthComponent'));

  const off = session.searchSymbols({ query: 'OFFSET_GWORLD', kinds: ['offset'] });
  assert.equal(off.items[0].summary, '0xcebcea0');
});

test('functions in Dumpspace array-of-objects shape are indexed individually', () => {
  const session = new DumpspaceSession();
  session.loadData({
    // Dumpspace export shape: owner -> [ { fnName: def }, ... ]
    functions: {
      USceneComponent: [
        {
          K2_AttachTo: [
            ['bool', 'D', '', []],
            [
              [['USceneComponent', 'C', '*', []], '', 'InParent'],
              [['FName', 'D', '', []], '', 'InSocketName']
            ],
            0x40c9a60,
            'Final|Native|Public|BlueprintCallable'
          ]
        }
      ]
    }
  });

  const hit = session.searchSymbols({ query: 'K2_AttachTo', kinds: ['function'] });
  assert.equal(hit.items.length, 1);
  assert.equal(hit.items[0].owner, 'USceneComponent');

  const detail = session.getSymbolDetail({ symbolId: 'function:USceneComponent::K2_AttachTo' });
  assert.equal(detail.found, true);
  assert.equal(detail.returnType, 'bool');
  assert.equal(detail.addressHex, '0x40c9a60');
  assert.equal(detail.flags, 'Final|Native|Public|BlueprintCallable');
  assert.deepEqual(
    detail.parameters.map((p) => `${p.type} ${p.name}`),
    ['USceneComponent* InParent', 'FName InSocketName']
  );
  assert.equal(
    detail.signature,
    'bool K2_AttachTo(USceneComponent* InParent, FName InSocketName)'
  );
});

test('enum detail resolves by bare name and exposes values and underlying type', () => {
  const session = new DumpspaceSession();
  session.loadData({
    enums: {
      // Dumpspace shape: [ [ {Name: value}, ... ], underlyingType ]
      EAutomationEventType: [[{ Info: 0 }, { Warning: 1 }, { Error: 2 }], 'uint8']
    }
  });

  const detail = session.getSymbolDetail({ name: 'EAutomationEventType' });
  assert.equal(detail.found, true);
  assert.equal(detail.underlyingType, 'uint8');
  assert.deepEqual(detail.values, [
    { name: 'Info', value: 0 },
    { name: 'Warning', value: 1 },
    { name: 'Error', value: 2 }
  ]);
});

test('class detail exposes total instance size', () => {
  const session = new DumpspaceSession();
  session.loadData({
    classes: {
      AActor: [{ __InheritInfo: ['UObject'] }, { __MDKClassSize: 752 }]
    }
  });

  const detail = session.getSymbolDetail({ name: 'AActor' });
  assert.equal(detail.size, 752);
  assert.equal(detail.sizeHex, '0x2f0');
});

test('offset detail resolves by bare name with hex value', () => {
  const session = new DumpspaceSession();
  session.loadData({ offsets: { OFFSET_GWORLD: 0xcebcea0 } });

  const detail = session.getSymbolDetail({ name: 'OFFSET_GWORLD' });
  assert.equal(detail.found, true);
  assert.equal(detail.valueHex, '0xcebcea0');
});

test('multi-element __InheritInfo resolves the direct parent, not the root', () => {
  const session = new DumpspaceSession();
  session.loadData({
    classes: {
      UObject: [{ __InheritInfo: [] }],
      AActor: [{ __InheritInfo: ['UObject'] }],
      APawn: [{ __InheritInfo: ['AActor', 'UObject'] }],
      // Real Dumper-7 lists the full ancestor chain, direct parent first.
      ACharacter: [{ __InheritInfo: ['APawn', 'AActor', 'UObject'] }]
    }
  });

  // Direct parent must be APawn (first entry), not UObject (last).
  assert.deepEqual(session.getInheritancePath('ACharacter'), [
    'ACharacter',
    'APawn',
    'AActor',
    'UObject'
  ]);

  // inherits: filter must see every ancestor, including intermediate ones.
  const pawns = session.searchSymbols({ query: 'inherits:APawn', kinds: ['class'] });
  assert.ok(pawns.items.some((i) => i.name === 'ACharacter'));

  // children index must attach ACharacter to its direct parent APawn.
  const detail = session.getSymbolDetail({ name: 'APawn' });
  assert.deepEqual(detail.children, ['ACharacter']);

  const rel = session.explainTypeRelationship({ from: 'ACharacter', to: 'AActor' });
  assert.equal(rel.relationship, 'derived-to-base');
  assert.deepEqual(rel.path, ['ACharacter', 'APawn', 'AActor']);
});

test('limits are capped by maxLimit but default when omitted', () => {
  const session = new DumpspaceSession({ defaultLimit: 2, maxLimit: 3 });
  session.loadData(fixture);

  const defaulted = session.searchSymbols({ query: '*' });
  assert.equal(defaulted.page.limit, 2);

  const capped = session.searchSymbols({ query: '*', limit: 100 });
  assert.equal(capped.page.limit, 3);
  assert.equal(capped.items.length, 3);
});
