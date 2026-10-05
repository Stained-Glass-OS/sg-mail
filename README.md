# SG Mail

Stained Glass OS's mail and calendar program. Its window is arranged the way
many office workers know from classic desktop mail clients: a ribbon (Home,
Send / Receive, Folder, View), the folder pane with Favorites and unread
counts, the message list grouped by date (Today, Yesterday, Last Week, ...),
the reading pane, a message window, and a Calendar with Day, Work Week, Week
and Month views. The keys are the familiar ones (Ctrl+N, Ctrl+R,
Ctrl+Shift+R, Ctrl+F forward, Ctrl+E search, Ctrl+Q / Ctrl+U read/unread,
Insert flag, Delete, Backspace archive, Ctrl+Shift+V move, F9 Send/Receive,
Ctrl+1 / Ctrl+2 Mail / Calendar, Ctrl+Alt+1..4 calendar views).

![SG Mail, light](docs/screenshots/sg-mail-light.png)
![SG Mail's calendar, dark](docs/screenshots/sg-mail-calendar-dark.png)

(More in docs/screenshots: the message window, light and dark. The look
gate takes them against the test servers.)

## Thunderbird underneath

SG Mail is built on **Mozilla Thunderbird**, not modified. On Stained Glass
OS that is the `thunderbird` package of its own apt repository: Mozilla's
official Linux build of the current Release (sg-image's `thunderbird/`,
verified against Mozilla's signed checksums, rebuilt when Mozilla releases;
it replaces Debian's ESR package in place). SG Mail also runs on Debian's
Thunderbird 140. Thunderbird does the mail and calendar work: IMAP, POP and
SMTP accounts, Exchange (EWS) and Microsoft 365 (Microsoft Graph) mail
accounts, the provider's own sign-in page for Microsoft (Outlook.com,
Microsoft 365) and Google accounts (OAuth2 with Thunderbird's registration:
nothing to register for SG Mail), setup from the e-mail address (ISPDB /
autoconfig, Exchange Autodiscover), the calendar (local, CalDAV, Internet
calendars; meeting invitations), the address book, filters and the offline
store. Security updates come with the thunderbird package.

What SG Mail adds is its window: an extension (`extension/`, id
`sg-mail@stained-glass-os.org`) that makes Thunderbird's main window SG
Mail's when Thunderbird runs with SG Mail's profile:

- `ui/` -- the main window (ribbon, folder pane, message list, reading pane,
  calendar, navigation bar, status bar), the message window and the
  appointment window, written against Thunderbird's WebExtension APIs
  (accounts, folders, messages, address books);
- `experiments/` -- a privileged experiment API (`sgmail`) for what those
  APIs do not reach: taking over the main window, Send/Receive, sending a
  message written in our window (Thunderbird's own sending: SMTP, Sent copy,
  drafts, Outbox), the calendar manager (calendars, events, recurrence,
  meetings, iTIP accept/decline), and opening Thunderbird's own account setup,
  account settings and options;
- `background.js` -- claims each main window, and turns Thunderbird's own
  message windows (mailto: links, "send to") into ours.

The reading pane shows HTML mail made safe: no scripts, frames, forms or
event handlers; a sandboxed frame without script; pictures from the network
only when the reader clicks "Download pictures" (or allows the sender).

`/usr/bin/sg-mail` (`launcher/sg-mail`) runs Thunderbird with SG Mail's own
profile (`~/.local/share/sg-mail/profile`; a person's own Thunderbird
profile is not touched), laying the extension and SG Mail's settings
(`launcher/user.js`, then an administrator's `/etc/sg-mail/user.js`) into it
on each start.

Account setup is Thunderbird's own (File > Add Account): on Thunderbird 145
and later its Account Hub, a dialog over SG Mail's window; on 140 its setup
tab. Microsoft accounts: type the address; the Account Hub finds Microsoft
365 and Exchange servers (Autodiscover) and offers Microsoft Graph (Microsoft
365) or Exchange Web Services (Exchange servers) besides IMAP, and signs in
with OAuth2 on Microsoft's own login page. Some work or school tenants
require their administrator to approve Thunderbird once (Microsoft's "admin
consent"), as for any Thunderbird user.

Calendars of Microsoft accounts: no Thunderbird release synchronises them
yet (Mozilla is writing Microsoft Graph calendar support; Thunderbird 157
carries an early, read-only version behind the `calendar.graph.enabled`
preference, off). Until it ships, subscribe to the calendar's published .ics
link (Add Network Calendar), or use CalDAV providers. When Mozilla ships it,
the thunderbird package brings it with the next release.

## Building and testing

    make lint            # syntax, manifests, desktop entry, AppStream, trademarks
    make xpi             # build/out/sg-mail@stained-glass-os.org.xpi
    make deb             # ../sg-mail_*_all.deb
    make root            # the test root (once): Debian trixie with Thunderbird,
                         # Xvfb, Dovecot, Radicale, aiosmtpd (rootless mmdebstrap)
    make test            # every gate
    make test TB_DEB=../thunderbird_157.0.1-sg1_amd64.deb
                         # every gate on that thunderbird package, over
                         # Debian's, in a root of its own
    make test-mutation   # every gate against its mutants (test/mutants.json)

The gates (`test/gate/*-gate.py`) run Thunderbird headless (Xvfb) in the test
root with no network but its own loopback: Dovecot (IMAP), an aiosmtpd SMTP
server that delivers locally, Radicale (CalDAV) and a small web server (the
account-setup lookup, and pictures whose fetches are counted). Nothing ever
reaches a real mail provider. They drive SG Mail's windows through a test
channel that exists only under a gate (`SG_MAIL_TEST_OUT`).

## License

AGPL-3.0-or-later (see LICENSE). Thunderbird is Mozilla's, MPL-2.0, and is
used as Mozilla builds it.
