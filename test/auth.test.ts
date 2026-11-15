import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { call, registerUser } from './helpers.js';

describe('accounts and sessions', () => {
  test('register returns tokens and the profile, never the password', async () => {
    const res = await call('POST', '/auth/register', {
      body: { name: 'Sarth', email: 'Sarth@Example.com', password: 'secret123', role: 'user' },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.accessToken && res.body.refreshToken);
    assert.equal(res.body.user.role, 'user');
    assert.ok(!JSON.stringify(res.body).includes('secret123'));
    assert.ok(!('passwordHash' in res.body.user));
  });

  test('emails are case-insensitive: registering again in another case is a conflict', async () => {
    const res = await call('POST', '/auth/register', {
      body: { name: 'Copy', email: 'sarth@example.COM', password: 'secret123', role: 'user' },
    });
    assert.equal(res.status, 409);
  });

  test('invalid input is rejected with field details', async () => {
    const res = await call('POST', '/auth/register', {
      body: { name: '', email: 'not-an-email', password: 'short', role: 'king' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  test('a failed login looks the same whether or not the email exists', async () => {
    const wrongPassword = await call('POST', '/auth/login', { body: { email: 'sarth@example.com', password: 'nope-nope' } });
    const unknownEmail = await call('POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'nope-nope' } });
    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(wrongPassword.body, unknownEmail.body);
  });

  test('protected routes need a valid access token', async () => {
    assert.equal((await call('GET', '/me')).status, 401);
    assert.equal((await call('GET', '/me', { token: 'garbage' })).status, 401);
    const user = await registerUser();
    const me = await call('GET', '/me', { token: user.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.email, user.email);
  });

  test('refresh rotates the refresh token: the old one stops working', async () => {
    const user = await registerUser();
    const first = await call('POST', '/auth/refresh', { body: { refreshToken: user.refreshToken } });
    assert.equal(first.status, 200);
    assert.notEqual(first.body.refreshToken, user.refreshToken);
    assert.equal((await call('GET', '/me', { token: first.body.accessToken })).status, 200);

    const reused = await call('POST', '/auth/refresh', { body: { refreshToken: user.refreshToken } });
    assert.equal(reused.status, 401);
  });

  test('logout ends that session immediately, but not the user\'s other sessions', async () => {
    const user = await registerUser();
    const other = await call('POST', '/auth/login', { body: { email: user.email, password: 'secret123' } });

    assert.equal((await call('POST', '/auth/logout', { token: user.token })).status, 204);
    assert.equal((await call('GET', '/me', { token: user.token })).status, 401);
    assert.equal((await call('POST', '/auth/refresh', { body: { refreshToken: user.refreshToken } })).status, 401);

    assert.equal((await call('GET', '/me', { token: other.body.accessToken })).status, 200);
  });
});
