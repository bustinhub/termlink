# RELAY v1.8 — UI Polish / Admin Drawer

Important: if you have NOT run the v1.7+ `supabase.sql` yet, the ADMIN button cannot appear yet because the role/license/group tables do not exist in your current database. Use the `supabase.sql` included in THIS v1.8 folder once you are ready; it includes the same required database upgrade.

UI changes in v1.8:
- Admin/mod access is now an obvious button in the top-left header area beside your avatar/settings button.
- Admin opens as a right-side drawer beside the active chat on desktop instead of a full-screen modal.
- Message history sits naturally near the composer when a chat has only a few messages; the chat no longer leaves a giant dead gap.
- Sender names are neutral white/gray instead of blue.
- Modal titles and green accent bars are centered, including New Group.
- Network background moves slightly faster.
- Chat/sidebar/admin scrollbars are dark gray/black and match the UI.
- Existing group chats, image attachments, license keys, admin/mod actions, and 100-message retention remain unchanged.

# RELAY v1.8

Private friend messenger built for GitHub -> Render + Supabase.

## What changed
- Site access code is `boisverysigma123`; license keys are consumed when users create accounts.
- `keymaster` is promoted to owner/admin by the SQL migration and server fallback.
- Admin panel: user search, ban/unban, mod assignment, DM/group chat inspection.
- Admin license-key generator with label, max uses, expiration and revocation.
- Consecutive messages from the same sender within 5 minutes render as one message block.
- Image attachment button plus clipboard image paste.
- Group chats created with the `+` beside CHATS.
- DMs and group chats each retain only the newest 100 messages.
- Old pruned image objects are also deleted from Supabase Storage.

## Required Supabase upgrade
Run the full `supabase.sql` in Supabase -> SQL Editor -> New query -> Run.
It is written as an upgrade script, so it can be run on the existing RELAY database.

The script:
- adds admin/mod/ban columns,
- promotes username `keymaster` to admin,
- adds license keys + moderation logs,
- adds groups + group messages,
- adds image attachment columns,
- creates a public `chat-media` bucket capped at 5 MB images.

## Render
Existing legacy commands remain compatible:
- Build: `yarn install`
- Start: `node src/server.js`

Environment variables:
- `NODE_ENV=production`
- `JWT_SECRET=<long random string>`
- `SUPABASE_URL=<project URL>`
- `SUPABASE_SERVICE_ROLE_KEY=<Supabase secret/service-role key>`
- optional `OWNER_USERNAME=keymaster`
