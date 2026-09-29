import { describe, expect, it } from 'vitest';
// @ts-expect-error The release scripts are plain JavaScript modules without declarations.
import { bumpFor, nextVersion, requestedRelease } from '../../../scripts/version.mjs';

const bump = bumpFor as (messages: string[]) => 'major' | 'minor' | 'patch' | undefined;
const next = nextVersion as (last: string, bump: 'major' | 'minor' | 'patch' | undefined) => string | undefined;
const requested = requestedRelease as (version: string, state: { tags: string[]; current: string }) => 'new' | 'resume';

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

  it('releases a requested version that is new, or resumes one already tagged when the code is at it', () => {
    const tags = ['v0.1.0-dev.0', 'v1.0.0-rc.1'];
    expect(requested('1.0.0-rc.2', { tags, current: '1.0.0-rc.1' })).toBe('new');
    expect(requested('1.0.0', { tags, current: '1.0.0-rc.1' })).toBe('new');
    // A release that stopped part-way, or was committed and tagged by hand, finishes from code at its version.
    expect(requested('1.0.0-rc.1', { tags, current: '1.0.0-rc.1' })).toBe('resume');
    expect(() => requested('1.0.0-rc.1', { tags, current: '1.0.0-rc.2' })).toThrow('resume a release only from code at its version');
    expect(() => requested('0.9.0', { tags, current: '1.0.0-rc.1' })).toThrow('not newer than the last release, v1.0.0-rc.1');
    expect(() => requested('one', { tags, current: '1.0.0-rc.1' })).toThrow('Not a semantic version');
  });
});
