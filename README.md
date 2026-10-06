# SG Mail

Stained Glass OS's mail and calendar program. Its window is arranged the way
many office workers know from classic desktop mail clients: a ribbon (Home,
Send / Receive, Folder, View), the folder pane with Favorites, unread counts
and Search Folders, the message list grouped by date (Today, Yesterday, Last
Week, ...), the reading pane (right, bottom or off), a message window, a
Calendar with Day, Work Week, Week and Month views, and People. The keys are
the familiar ones (Ctrl+N, Ctrl+R, Ctrl+Shift+R, Ctrl+F forward, Ctrl+E
search, Ctrl+Q / Ctrl+U read/unread, Insert flag, Delete, Backspace archive,
Ctrl+Shift+V move, F9 Send/Receive, Ctrl+1 / Ctrl+2 / Ctrl+3 Mail /
Calendar / People, Ctrl+Alt+1..4 calendar views).

- **Focused Inbox**: the Inbox in two tabs, Focused and Other. Bulk mail
  (mailing lists, newsletters, no-reply senders: their List-Unsubscribe,
  List-Id, Precedence and Auto-Submitted headers) goes to Other; people you
  know stay Focused (your contacts, people you have written or replied to).
  Decided on this computer from what Thunderbird keeps; nothing is sent
  anywhere. Right-click: Move to Focused / Other, or Always Move (the
  sender's mail from now on). View > Show Focused Inbox turns it off.
- **Calendar by the mouse**: drag an appointment to another time or day
  (Day, Work Week, Week, Month), drag its top or bottom edge (or the right
  end of an all-day or Month item) to change its length; for an occurrence of
  a series SG Mail asks "Just this one" or "The entire series", for your own
  meetings whether to send the attendees an update. Drag over free time (or
  days in Month) and type: a new appointment in place (Enter saves, Escape
  drops it; Enter without typing opens the appointment window).
- **People** in SG Mail's own window: the address books and their contact
  groups, the contact list with search, the contact card (Email, Meeting,
  Edit, Delete), new and edited contacts and groups. They are Thunderbird's
  address books (vCards, mailing lists): its own address book shows the same
  (More > Thunderbird's Address Book).
- **Reading pane** right, at the bottom (the list one line a message) or
  off, from View > Reading Pane; remembered, as the splitters are.
- **Search Folders** (Unread Mail, For Follow Up), **Categorize**
  (Thunderbird's tags, kept on the server as IMAP keywords), **Rules >
  Always Move Messages From** (a Thunderbird filter, run on new mail; Manage
  Rules & Alerts opens Thunderbird's filters).

Not there yet, against the classic desktop client in daily use: Quick Steps,
conversation view (threads), Clean Up / Ignore conversation, Tasks / To-Do,
the meeting Scheduling Assistant (free/busy), Automatic Replies (out of
office: a server feature of Exchange), shared and delegated calendars.

![SG Mail, light](docs/screenshots/sg-mail-light.png)
![SG Mail's calendar, dark](docs/screenshots/sg-mail-calendar-dark.png)
![People, light](docs/screenshots/sg-mail-people-light.png)

(More in docs/screenshots: each light and dark, and the message window. The
look gate takes them against the test servers.)

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
  meetings, iTIP accept/decline, events moved by the mouse), what the
  Focused Inbox decides by, rules (Thunderbird's filters), and opening
  Thunderbird's own account setup, account settings and options;
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
yet (Mozilla is writing Microsoft Graph calendar support). Thunderbird 157
carries an early version behind the `calendar.graph.enabled` preference,
off; SG Mail does not offer it, not even as a preview: it is read-only, it
needs a Microsoft 365 mail account set up over Graph, and it fetches only
each event's title, start and end, taking every time as UTC (Mozilla's own
note, bug 2058697), so appointments outside UTC would show at the wrong hour;
no places, attendees, series or reminders. Until Mozilla ships it, subscribe
to the calendar's published .ics link (Add Network Calendar), or use CalDAV
providers. When Mozilla ships it, the thunderbird package brings it with the
next release.

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
