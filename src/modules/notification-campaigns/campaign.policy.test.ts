import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftSchema, fillMessage, reachFor, reviewToken, selectAudience, type Recipient } from './campaign.policy.js';
const people: Recipient[] = [
 { id: 'one', memberId: 'one', userId: 'u1', name: 'Amina Rahman', due: 2000, email: null, push: false, staff: false },
 { id: 'two', memberId: 'two', userId: null, name: 'Karim', due: 100, email: 'karim@example.test', push: false, staff: false },
 { id: 'staff', memberId: null, userId: 'u2', name: 'Admin', due: 0, email: 'admin@example.test', push: true, staff: true },
 { id: 'three', memberId: 'three', userId: null, name: 'Nashit', due: 0, email: null, push: false, staff: false },
];
const draft = draftSchema.parse({ audience: 'all', title: 'Reminder', body: 'Hello {first_name}' });
test('empty explicit selection never becomes an all-members send', () => {
 assert.equal(draftSchema.safeParse({ ...draft, audience: 'pick', recipient_ids: [] }).success, false);
 assert.equal(selectAudience(people, { audience: 'pick', recipient_ids: ['foreign-member'] }).length, 0);
 assert.deepEqual(selectAudience(people, { audience: 'all', recipient_ids: [] }).map(p => p.id), ['one', 'two', 'three']);
 assert.deepEqual(selectAudience(people, { audience: 'staff', recipient_ids: [] }).map(p => p.id), ['staff']);
});
test('channel reach uses distinct recipients and the app/email union', () => {
 assert.deepEqual(reachFor(people, true, true), { total: 4, inbox: 2, push: 1, email: 2, unreached: 1 });
 assert.equal(reachFor(people, false, false).unreached, 2);
});
test('personalization uses whole taka balances and known tokens only', () => {
 assert.equal(fillMessage('Hi {first_name}, {due_amount} for {project}. {unknown}', people[0]!, 'Project B'), 'Hi Amina, ৳2,000 for Project B. {unknown}');
});
test('review is invalidated by changes to project, audience, channel, balance or message', () => {
 const token = reviewToken('p', draft, people);
 assert.equal(reviewToken('p', draft, [...people].reverse()), token);
 assert.notEqual(reviewToken('other', draft, people), token);
 assert.notEqual(reviewToken('p', { ...draft, email: true }, people), token);
 assert.notEqual(reviewToken('p', draft, [{ ...people[0]!, email: 'new@example.test' }, ...people.slice(1)]), token);
 assert.notEqual(reviewToken('p', { ...draft, body: 'Edited' }, people), token);
});
test('server enforces the UI length limits and trims whitespace', () => {
 for (const update of [{ title: '   ' }, { body: '  ' }, { title: 'x'.repeat(66) }, { body: 'x'.repeat(501) }, { destination: 'external-url' }]) assert.equal(draftSchema.safeParse({ ...draft, ...update }).success, false);
 assert.equal(draftSchema.parse({ ...draft, title: '  Hello  ' }).title, 'Hello');
});


test('adding, replacing or removing a campaign photo invalidates the reviewed token', () => {
 const plain=reviewToken('p',draft,people),photo=reviewToken('p',{...draft,image_file_id:'photo'},people);
 assert.notEqual(plain,photo);assert.notEqual(photo,reviewToken('p',{...draft,image_file_id:'replacement'},people));
 assert.equal(draftSchema.safeParse({...draft,image_file_id:''}).success,false);
});
