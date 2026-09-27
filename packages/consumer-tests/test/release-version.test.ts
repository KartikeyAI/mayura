import { describe, expect, it } from 'vitest';
// @ts-expect-error The release scripts are plain JavaScript modules without declarations.
import { bumpFor, nextVersion } from '../../../scripts/version.mjs';

const bump = bumpFor as (messages: string[]) => 'major' | 'minor' | 'patch' | undefined;
const next = nextVersion as (last: string, bump: 'major' | 'minor' | 'patch' | undefined) => string | undefined;

describe('release versions from Conventional Commits', () => {
  it('picks the largest bump the commits call for', () => {
    expect(bump(['docs: tidy', 'chore: deps', 'test: more'])).toBeUndefined();
    expect(bump(['fix: a bug', 'docs: tidy'])).toBe('patch');
    expect(bump(['perf(runtime): faster'])).toBe('patch');
    expect(bump(['fix: a bug', 'feat(cli): mayura dev'])).toBe('minor');
    expect(bump(['feat!: remove the old API'])).toBe('major');
    expect(bump(['feat: new thing\n\nBREAKING CHANGE: the config moved'])).toBe('major');
    // The release commit itself never triggers another release.
    expect(bump(['chore(release): v1.2.0 [skip ci]'])).toBeUndefined();
  });

  it('bumps stable versions, keeps 0.x breaking changes minor, and continues prereleases', () => {
    expect(next('1.2.3', 'patch')).toBe('1.2.4');
    expect(next('1.2.3', 'minor')).toBe('1.3.0');
    expect(next('1.2.3', 'major')).toBe('2.0.0');
    expect(next('0.4.1', 'major')).toBe('0.5.0');
    expect(next('1.0.0-rc.1', 'minor')).toBe('1.0.0-rc.2');
    expect(next('1.0.0-beta', 'patch')).toBe('1.0.0-beta.1');
    expect(next('1.2.3', undefined)).toBeUndefined();
  });
});
