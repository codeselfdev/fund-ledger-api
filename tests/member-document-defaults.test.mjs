import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MEMBER_DOCUMENT_TITLES, seedMemberDocumentTitles, withDefaultMemberDocumentTitles } from '../dist/core/projects/member-document-titles.js';

test('fund defaults have stable saved IDs, active status and timestamps while preserving organization data', () => {
  const original = { subscription: { status: 'trial' }, email: 'owner@example.test' };
  const contact = withDefaultMemberDocumentTitles(original, 'fund_shares');
  assert.deepEqual(contact.member_document_titles.map(row => row.title), [
    'Identity card', 'Business card', 'Address proof', 'Legal document', 'Property document', 'Passport'
  ]);
  assert.equal(new Set(contact.member_document_titles.map(row => row.id)).size, DEFAULT_MEMBER_DOCUMENT_TITLES.length);
  assert.ok(contact.member_document_titles.every(row => row.id && row.is_active && !Number.isNaN(Date.parse(row.created_at)) && row.created_at === row.updated_at));
  assert.deepEqual(contact.subscription, original.subscription);
  assert.equal(contact.email, original.email);
  assert.equal(original.member_document_titles, undefined);
  assert.equal(withDefaultMemberDocumentTitles(contact, 'fund_shares'), contact);
});

test('additional projects preserve renamed, disabled and explicitly empty title lists', async () => {
  for (const titles of [[], [{ id: 'saved', title: 'Custom ID', is_active: false }]]) {
    const contact = { member_document_titles: titles, subscription: { status: 'active' } };
    assert.equal(withDefaultMemberDocumentTitles(contact, 'fund_shares'), contact);
    await seedMemberDocumentTitles({ tenant: {
      findUniqueOrThrow: async () => ({ contact }),
      update: async () => assert.fail('Configured titles must never be overwritten')
    } }, 'tenant', 'fund_shares');
  }
});

test('other project types never seed titles or read organization settings', async () => {
  for (const type of ['accounting', 'billing', 'construction', 'payroll_pf', 'institute']) {
    const contact = { subscription: { status: 'trial' } };
    assert.equal(withDefaultMemberDocumentTitles(contact, type), contact);
    await seedMemberDocumentTitles({}, 'tenant', type);
  }
});

test('first fund in an existing organization saves defaults using the scoped settings version', async () => {
  const updatedAt = new Date();
  let saved;
  await seedMemberDocumentTitles({ tenant: {
    findUniqueOrThrow: async args => {
      assert.deepEqual(args.where, { id: 'target-tenant' });
      return { contact: { phone: 'saved-phone' }, updatedAt };
    },
    update: async args => { saved = args; }
  } }, 'target-tenant', 'fund_shares');
  assert.deepEqual(saved.where, { id: 'target-tenant', updatedAt });
  assert.equal(saved.data.contact.phone, 'saved-phone');
  assert.equal(saved.data.contact.member_document_titles.length, 6);
});

test('a conflicting settings edit aborts seeding so the enclosing project transaction can roll back', async () => {
  const conflict = new Error('Settings changed');
  await assert.rejects(seedMemberDocumentTitles({ tenant: {
    findUniqueOrThrow: async () => ({ contact: null, updatedAt: new Date() }),
    update: async () => { throw conflict; }
  } }, 'tenant', 'fund_shares'), error => error === conflict);
});
