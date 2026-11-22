/** Pure author-contract intake. No question generation, provider, journal, credential or filesystem port. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

function plain(value, seen = new Set(), depth = 0, budget = {nodes: 0, characters: 0}) {
  assert.ok(depth <= 40 && ++budget.nodes <= 250000, 'HOLDOUT_DATA_DEPTH');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {budget.characters += value.length; assert.ok(value.length <= 1048576 && budget.characters <= 16777216); return value;}
  if (typeof value === 'number') {assert.ok(Number.isFinite(value)); return value;}
  assert.ok(value && typeof value === 'object' && !seen.has(value), 'HOLDOUT_PLAIN_DATA_REQUIRED');
  assert.ok(Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  assert.ok(keys.every(key => typeof key === 'string')); seen.add(value);
  const own = key => {const descriptor = descriptors[key]; assert.ok(descriptor && Object.hasOwn(descriptor, 'value'), 'HOLDOUT_ACCESSOR_DENIED');
    return plain(descriptor.value, seen, depth + 1, budget);};
  let result;
  if (Array.isArray(value)) {const length = descriptors.length.value; assert.ok(length <= 100000 && keys.length === length + 1);
    result = Array.from({length}, (_, index) => own(String(index)));}
  else result = Object.fromEntries(keys.sort().map(key => [key, own(key)]));
  seen.delete(value); return result;
}
const freeze = value => {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);} return value;};
export const productionHoldoutHashV1 = value => createHash('sha256').update(JSON.stringify(plain(value))).digest('hex');
export const productionHoldoutTextHashV1 = text => {assert.equal(typeof text, 'string'); return createHash('sha256').update(text).digest('hex');};
export const sealProductionHoldoutReviewV1 = body => {const copy = plain(body); assert.ok(!Object.hasOwn(copy, 'digest'));
  return freeze({...copy, digest: productionHoldoutHashV1(copy)});};
const sealed = value => {const copy = plain(value), {digest, ...body} = copy;
  assert.equal(productionHoldoutHashV1(body), digest, 'HOLDOUT_SEAL_CHANGED'); return copy;};
const hex = value => assert.match(value ?? '', /^[a-f0-9]{64}$/u, 'HOLDOUT_EXTERNAL_PIN_REQUIRED');
const text = value => assert.ok(typeof value === 'string' && value.trim().length > 0 && value.length <= 16000, 'HOLDOUT_TEXT_REQUIRED');
const equalSet = (actual, expected) => {assert.ok(Array.isArray(actual)); assert.equal(new Set(actual).size, actual.length);
  assert.deepEqual([...actual].sort(), [...expected].sort(), 'HOLDOUT_REVIEW_POPULATION_CHANGED');};
function active(options) {
  assert.ok(options && Object.getPrototypeOf(options) === Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(options); assert.ok(Reflect.ownKeys(descriptors).every(key => key === 'signal'));
  if (descriptors.signal) {assert.ok(Object.hasOwn(descriptors.signal, 'value'), 'HOLDOUT_ACCESSOR_DENIED');
    const signal = descriptors.signal.value; assert.ok(signal instanceof AbortSignal); AbortSignal.prototype.throwIfAborted.call(signal);}
}
export const PRODUCTION_HOLDOUT_TOPICS_V1 = freeze(['config', 'discovery', 'querying', 'rules', 'alerts', 'storage', 'security', 'operations']);
const slots = PRODUCTION_HOLDOUT_TOPICS_V1.flatMap(topic => ['single', 'single', 'multiple', 'multiple', 'abstention'].map((cohort, index) =>
  ({id: `${topic}-${cohort}-${index % 2 + 1}`, topic, cohort, requiredFacts: cohort === 'single' ? 1 : cohort === 'multiple' ? 2 : 0})));
export const PRODUCTION_HOLDOUT_REVIEW_SCHEMA_V1 = freeze({version: 1, phase: 'author-contract-review',
  population: {cases: 40, topics: 8, single: 16, multiple: 16, abstention: 8, answerable: 32, facts: 48},
  topics: PRODUCTION_HOLDOUT_TOPICS_V1, slots, witnessOffsets: 'document-local UTF16 code units; sourceStart=document.start+start',
  authorKind: 'ai', reviewerKind: 'independent-ai', reviewerProvider: 'deepseek',
  globalExternalNoveltyCertified: false, humanReviewClaimed: false, qualificationAllowed: false});

/** Four already-frozen external bindings create slots, never permission to write questions or spend. */
export function buildAuthoringTemplate(bindings, options = {}) {
  active(options); bindings = plain(bindings);
  assert.deepEqual(Object.keys(bindings).sort(), ['catalogDigest', 'runtimeDigest', 'sourceCandidateDigest', 'exposureDigest'].sort());
  Object.values(bindings).forEach(hex);
  return sealProductionHoldoutReviewV1({kind: 'production-holdout-authoring-template-v1', schemaDigest: productionHoldoutHashV1(PRODUCTION_HOLDOUT_REVIEW_SCHEMA_V1),
    bindings: {...bindings, sourceCatalogDigest: null, cutoffDigest: null}, plannedSlots: slots, questions: null, labels: null,
    reviewedAccepted: false, authoringAllowed: false, independentReviewComplete: false, liveReturnedPairReviewComplete: false,
    executionAllowed: false, qualificationAllowed: false, productionReady: false, ragStatus: 'experimental'});
}
export const buildAuthoringTemplateV1 = buildAuthoringTemplate;

function boundary(value, index) {return !(index > 0 && index < value.length && value.charCodeAt(index) >= 0xdc00 &&
  value.charCodeAt(index) <= 0xdfff && value.charCodeAt(index - 1) >= 0xd800 && value.charCodeAt(index - 1) <= 0xdbff);}
function witness(raw, documents, sourceTexts) {
  const document = documents.get(raw.documentId), content = sourceTexts.get(raw.documentId); assert.ok(document && typeof content === 'string');
  assert.equal(raw.sourceId, document.sourceId); assert.equal(raw.sourceFamilyId, document.sourceFamilyId);
  assert.equal(raw.reference, document.reference); assert.equal(raw.documentSha256, document.sha256);
  assert.ok(Number.isSafeInteger(raw.start) && Number.isSafeInteger(raw.end) && raw.start >= 0 && raw.end > raw.start && raw.end <= content.length);
  assert.ok(boundary(content, raw.start) && boundary(content, raw.end));
  assert.equal(raw.sourceStart, document.start + raw.start); assert.equal(raw.sourceEnd, document.start + raw.end);
  assert.equal(raw.quote, content.slice(raw.start, raw.end)); assert.equal(raw.quoteSha256, productionHoldoutTextHashV1(raw.quote));
  assert.ok(raw.quote.length <= 8000);
  return productionHoldoutHashV1(raw);
}

/** Independent pins are caller-supplied authority; a proposed packet or self-declared ready flag is insufficient. */
export function validateReviewedProductionHoldoutV1(input, options = {}) {
  active(options); const data = plain(input), {expectedBinding: binding} = data;
  assert.deepEqual(Object.keys(binding).sort(), ['catalogDigest', 'sourceCatalogDigest', 'runtimeDigest', 'sourceCandidateDigest', 'exposureDigest', 'cutoffDigest'].sort());
  Object.values(binding).forEach(hex); hex(data.expectedAuthorDigest); hex(data.expectedReviewDigest); text(data.expectedReviewerId);
  const catalog = sealed(data.catalog), runtime = sealed(data.runtime), author = sealed(data.authorPacket), review = sealed(data.reviewPacket);
  assert.equal(catalog.digest, binding.catalogDigest); assert.equal(catalog.sourceCatalogDigest, binding.sourceCatalogDigest);
  assert.equal(productionHoldoutHashV1(catalog.sourceCatalog), binding.sourceCatalogDigest);
  assert.equal(catalog.sourceCandidateDigest, binding.sourceCandidateDigest);
  assert.equal(runtime.digest, binding.runtimeDigest); assert.equal(runtime.allPhaseImplementationsReady, true, 'HOLDOUT_RUNTIME_NOT_FROZEN');
  assert.equal(runtime.questionAuthoringAllowed, true, 'HOLDOUT_AUTHORING_NOT_ADMITTED');
  assert.equal(author.digest, data.expectedAuthorDigest); assert.equal(review.digest, data.expectedReviewDigest, 'HOLDOUT_INDEPENDENT_REVIEW_PIN_CHANGED');
  assert.equal(author.kind, 'production-holdout-author-packet-v1'); assert.equal(review.kind, 'production-holdout-independent-review-v1');
  assert.equal(author.schemaDigest, productionHoldoutHashV1(PRODUCTION_HOLDOUT_REVIEW_SCHEMA_V1)); assert.equal(review.schemaDigest, author.schemaDigest);
  assert.deepEqual(author.binding, binding); assert.deepEqual(review.binding, binding);
  assert.equal(author.authorKind, 'ai'); text(author.authorId); assert.equal(review.reviewer.kind, 'independent-ai');
  assert.equal(author.reviewedAccepted, false); assert.equal(author.humanReviewClaimed, false); assert.equal(author.globalExternalNoveltyCertified, false);
  assert.equal(review.reviewer.provider, 'deepseek'); assert.equal(review.reviewer.id, data.expectedReviewerId);
  assert.notEqual(review.reviewer.id, author.authorId); text(review.reviewer.sessionId);
  assert.equal(review.reviewer.stateless, true); assert.equal(review.reviewer.blindToRankingsAndAuthorLabels, true);
  hex(review.reviewReceiptDigest); assert.equal(review.authorPacketDigest, author.digest);
  assert.equal(review.phase, 'author-contract-review'); assert.equal(review.reviewedAccepted, true);
  assert.equal(review.humanReviewClaimed, false); assert.equal(review.globalExternalNoveltyCertified, false);
  assert.equal(review.liveReturnedPairReviewComplete, false); assert.deepEqual(review.returnedPairJudgments, []);
  const documents = new Map(), sourceTexts = new Map();
  for (const row of catalog.sourceTexts) {assert.ok(!sourceTexts.has(row.id)); sourceTexts.set(row.id, row.text);}
  for (const row of catalog.sourceCatalog.documents) {
    assert.ok(!documents.has(row.id)); assert.equal(row.prefix, '');
    assert.equal(productionHoldoutTextHashV1(sourceTexts.get(row.id)), row.sha256);
    assert.ok(Number.isSafeInteger(row.start) && row.start >= 0 && Number.isSafeInteger(row.end) && row.end > row.start && row.end - row.start === sourceTexts.get(row.id).length);
    text(row.sourceId); text(row.sourceFamilyId); text(row.reference); documents.set(row.id, row);
  }
  equalSet([...sourceTexts.keys()], [...documents.keys()]); assert.equal(author.cases.length, 40); assert.equal(review.cases.length, 40);
  const caseMap = new Map(), currentPositives = [], expectedDecisions = new Map(); let facts = 0;
  for (const value of author.cases) {
    active(options); const expected = slots.find(slot => slot.id === value.id); assert.ok(expected && !caseMap.has(value.id)); caseMap.set(value.id, value);
    assert.equal(value.topic, expected.topic); assert.equal(value.cohort, expected.cohort); text(value.question);
    assert.ok(value.question.length <= 2000 && value.question.isWellFormed(), 'HOLDOUT_PIPELINE_QUESTION_REQUIRED');
    assert.equal(value.questionDigest, productionHoldoutTextHashV1(value.question));
    assert.deepEqual(Object.keys(value.scope).sort(), ['sourceCommit', 'applicability', 'exclusions'].sort());
    text(value.scope.applicability); assert.equal(value.scope.sourceCommit, catalog.commit); assert.ok(Array.isArray(value.scope.exclusions));
    value.scope.exclusions.forEach(text); assert.equal(value.scopeDigest, productionHoldoutHashV1(value.scope));
    assert.equal(value.facts.length, expected.requiredFacts); const factIds = new Set(), assertions = new Set(), witnesses = [];
    for (const fact of value.facts) {
      text(fact.id); assert.ok(!factIds.has(fact.id)); factIds.add(fact.id); text(fact.assertion);
      assert.ok(!assertions.has(fact.assertion)); assertions.add(fact.assertion); assert.ok(fact.witnesses.length > 0);
      const {digest, ...body} = fact; assert.equal(digest, productionHoldoutHashV1(body)); facts++;
      const digests = fact.witnesses.map(row => witness(row, documents, sourceTexts)); equalSet(digests, digests); witnesses.push(fact.witnesses);
      const positives = digests.map(witnessDigest => productionHoldoutHashV1({caseId: value.id, questionDigest: value.questionDigest,
        scopeDigest: value.scopeDigest, factId: fact.id, factDigest: fact.digest, witnessDigest})); currentPositives.push(...positives);
      expectedDecisions.set(value.id + '/' + fact.id, {factDigest: fact.digest, witnessDigests: digests});
    }
    if (expected.cohort === 'multiple') assert.ok(witnesses[0].some(a => witnesses[1].some(b => a.sourceFamilyId !== b.sourceFamilyId && a.reference !== b.reference)), 'HOLDOUT_DISTINCT_SOURCE_PAGES_REQUIRED');
    const {caseDigest, ...body} = value; assert.equal(caseDigest, productionHoldoutHashV1(body));
  }
  assert.equal(facts, 48); equalSet([...caseMap.keys()], slots.map(slot => slot.id));
  data.expectedPriorPositiveDigests.forEach(hex); author.positiveDigests.forEach(hex);
  equalSet(author.positiveDigests, [...new Set([...currentPositives, ...data.expectedPriorPositiveDigests])]);
  const reviewed = new Set();
  for (const decision of review.cases) {
    const value = caseMap.get(decision.caseId); assert.ok(value && !reviewed.has(value.id)); reviewed.add(value.id);
    assert.equal(decision.caseDigest, value.caseDigest); assert.equal(decision.questionDigest, value.questionDigest);
    assert.equal(decision.scopeDigest, value.scopeDigest); assert.equal(decision.scopeAccepted, true);
    assert.equal(decision.supportability, value.cohort === 'abstention' ? 'unsupported' : 'supported');
    equalSet(decision.facts.map(fact => fact.factId), value.facts.map(fact => fact.id));
    for (const fact of decision.facts) {const expected = expectedDecisions.get(value.id + '/' + fact.factId);
      assert.equal(fact.factDigest, expected.factDigest); assert.equal(fact.entailment, 'supported'); equalSet(fact.witnessDigests, expected.witnessDigests);}
  }
  equalSet([...reviewed], [...caseMap.keys()]); assert.deepEqual(review.unresolvedDisputes, []); assert.deepEqual(review.newPositiveProposals, []);
  active(options); return sealProductionHoldoutReviewV1({kind: 'production-holdout-reviewed-author-contracts-v1', binding,
    authorPacketDigest: author.digest, independentReviewDigest: review.digest, independentReviewerId: data.expectedReviewerId,
    reviewedAccepted: true, authorContractsAccepted: true, allPositivesPreserved: true, facts: 48, cases: 40,
    authorityProfile: 'ai-authored-independent-ai-reviewed-v1', humanReviewClaimed: false, globalExternalNoveltyCertified: false,
    liveReturnedPairReviewComplete: false, executionAllowed: false, qualificationAllowed: false, productionReady: false, ragStatus: 'experimental'});
}
