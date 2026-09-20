import { describe, expect, it } from 'vitest';
import { Budget, type Reservation, type BundleOperation as Operation, type BudgetBundle as Bundle } from '../src/index.js';

/** Proxies are trusted local code, not a sandbox. Their reflection may reenter before admission,
 * so every lineage/capacity predicate must be checked after the complete input snapshot is taken.
 */
function duringReflection(operation: Operation, callback: () => void): Operation {
  let invoked = false;
  return new Proxy(operation, {
    getOwnPropertyDescriptor(target,key) {
      if (!invoked) { invoked = true; callback(); }
      return Reflect.getOwnPropertyDescriptor(target,key);
    },
  });
}

describe('budget bundle independent adversarial review', () => {
  it('rechecks capacity after a descriptor trap consumes the last shared call', () => {
    const root = new Budget(10,1); let competing: Reservation | undefined;
    const candidate = duringReflection({id:'outer',maxCostMicros:5},() => { competing = root.reserve(0); });
    expect(() => root.reserveBundle([candidate])).toThrow(expect.objectContaining({code:'BUDGET_EXCEEDED'}));
    expect(competing).toBeDefined();
    expect(root.snapshot()).toEqual({spentMicros:0,reservedMicros:0,calls:1});
    expect(root.capacitySnapshot()).toEqual({heldCalls:0});
  });

  it('rechecks closed ancestors after reflection and never burns the rejected identity', () => {
    const root = new Budget(10,5); const middle = root.fork({id:'middle',maxCostMicros:10,maxCalls:5});
    const leaf = middle.fork({id:'leaf',maxCostMicros:10,maxCalls:5});
    const candidate = duringReflection({id:'reusable-after-failure',maxCostMicros:5},() => { middle.close(); });
    expect(() => leaf.reserveBundle([candidate])).toThrow(expect.objectContaining({code:'BUDGET_EXCEEDED'}));
    expect(root.snapshot()).toEqual({spentMicros:0,reservedMicros:0,calls:0});
    expect(leaf.capacitySnapshot()).toEqual({heldCalls:0});
    const accepted = root.reserveBundle([{id:'reusable-after-failure',maxCostMicros:5}]);
    expect(accepted.tickets).toHaveLength(1); expect(root.capacitySnapshot()).toEqual({heldCalls:1});
    accepted.close();
  });

  it('handles reentrant bundle identity registration without partly committing the outer bundle', () => {
    const root = new Budget(10,5); let competing: Bundle | undefined;
    const candidate = duringReflection({id:'collision',maxCostMicros:1},() => {
      competing = root.reserveBundle([{id:'collision',maxCostMicros:1}]);
    });
    expect(() => root.reserveBundle([{id:'not-burned',maxCostMicros:2},candidate])).toThrow(expect.objectContaining({code:'CONFLICT'}));
    expect(root.snapshot()).toEqual({spentMicros:0,reservedMicros:1,calls:0});
    expect(root.capacitySnapshot()).toEqual({heldCalls:1});
    const accepted = root.reserveBundle([{id:'not-burned',maxCostMicros:2}]);
    expect(root.snapshot()).toEqual({spentMicros:0,reservedMicros:3,calls:0});
    competing!.close(); accepted.close(); expect(root.capacitySnapshot()).toEqual({heldCalls:0});
  });

  it('retains invalid unsettled descendant tickets in the global cap until valid late settlement', () => {
    const root = new Budget(0,4_096); const child = root.fork({id:'child',maxCostMicros:0,maxCalls:4_096});
    const initial = Array.from({length:8},(_,batch) => child.reserveBundle(Array.from({length:128},(_,index) => ({id:`original-${batch}-${index}`,maxCostMicros:0}))));
    const pending = initial[0]!.tickets[0]!.start(); child.close();
    expect(() => pending.settle(Number.NaN)).toThrow(expect.objectContaining({code:'BUDGET_EXCEEDED'}));
    for (const bundle of initial) bundle.close();
    expect(root.snapshot()).toEqual({spentMicros:0,reservedMicros:0,calls:1});
    expect(root.capacitySnapshot()).toEqual({heldCalls:0});
    const later: Bundle[] = [];
    for (let batch = 0; batch < 8; batch++) later.push(root.reserveBundle(Array.from({length:batch === 7 ? 127 : 128},(_,index) => ({id:`later-${batch}-${index}`,maxCostMicros:0}))));
    expect(() => root.reserveBundle([{id:'one-more',maxCostMicros:0}])).toThrow(expect.objectContaining({code:'LIMIT_EXCEEDED'}));
    pending.settle(0);
    const accepted = root.reserveBundle([{id:'one-more',maxCostMicros:0}]);
    expect(root.capacitySnapshot()).toEqual({heldCalls:1_024});
    expect(() => pending.settle(0)).toThrow(expect.objectContaining({code:'CONFLICT'}));
    for (const bundle of later) bundle.close(); accepted.close();
    expect(root.capacitySnapshot()).toEqual({heldCalls:0});
  });
});
