// SG Mail's Thunderbird profile: what /usr/bin/sg-mail writes into it on
// every start (user.js wins over what the profile keeps in prefs.js).
// Copyright (C) 2026 Stained Glass OS contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// this profile is SG Mail's: our extension takes the main window
user_pref("sgmail.profile", true);
// our extension, laid in the profile by the launcher, enabled without asking,
// and looked at on every start (a package upgrade replaces it)
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.startupScanScopes", 5);
// the session frames the window (title bar and buttons as every window's)
user_pref("mail.tabs.drawInTitlebar", false);
// no first-run pages, default-client questions or donation tabs
user_pref("mail.shell.checkDefaultClient", false);
user_pref("mail.shell.checkDefaultMail", false);
user_pref("mailnews.start_page.enabled", false);
user_pref("mail.rights.version", 1);
user_pref("mail.provider.suppress_dialog_on_startup", true);
user_pref("app.donation.eoy.version.viewed", 99);
user_pref("mail.inappnotifications.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
// Debian updates Thunderbird; SG Mail's add-on comes with its package
user_pref("app.update.enabled", false);
user_pref("extensions.update.enabled", false);
// SG Mail shows new mail and reminders itself (desktop notifications)
user_pref("mail.biff.show_alert", false);
user_pref("calendar.alarms.show", false);
user_pref("calendar.alarms.showmissed", false);
// Outlook's way: replies above the quote
user_pref("mail.identity.default.reply_on_top", 1);
// remote content in messages stays blocked (SG Mail's reading pane asks)
user_pref("mailnews.message_display.disable_remote_image", true);
// launcher/userChrome.css: no glimpse of Thunderbird's own view at start
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
