# SG Mail -- Stained Glass OS's mail and calendar: Thunderbird (Debian's,
# unmodified) underneath, our window on top (a Thunderbird extension).
#
#   make xpi            the extension             -> build/out/sg-mail@stained-glass-os.org.xpi
#   make install        lay it out under DESTDIR (/usr/bin/sg-mail, /usr/share/sg-mail, ...)
#   make lint           syntax, manifests, desktop entry, AppStream, trademarks
#   make test           lint + every gate (test/gate/*.py) in the test root
#   make test-mutation  each gate against its mutants: it must fail
#   make deb            the package sg-mail       -> ../sg-mail_*_all.deb
#   make root           the test root (Debian trixie: Thunderbird, Xvfb,
#                       Dovecot, Radicale, aiosmtpd), made once, rootless
#
# The gates run Thunderbird with local stand-in servers only, in a network
# namespace of their own: nothing reaches a real mail provider.
EXT_ID   = sg-mail@stained-glass-os.org
OUT     ?= build/out
XPI      = $(OUT)/$(EXT_ID).xpi
DESTDIR ?=
PREFIX  ?= /usr
ROOT    ?= /var/tmp/sgmail/root-tb
PY      ?= python3
GATES   ?= $(sort $(wildcard test/gate/*-gate.py))
INROOT   = SG_NONET=1 SG_ROOT=$(ROOT) SG_CWD=$(CURDIR) sh build/inroot.sh

.PHONY: all xpi install lint test test-mutation deb root clean
all: xpi

xpi:
	@mkdir -p $(OUT)
	@rm -f $(XPI)
	@cd extension && find . -type f ! -name '*~' | LC_ALL=C sort | TZ=UTC zip -q -X -D -@ ../$(XPI)
	@echo "$(XPI)"

install: xpi
	install -D -m0755 launcher/sg-mail $(DESTDIR)$(PREFIX)/bin/sg-mail
	install -D -m0644 $(XPI) $(DESTDIR)$(PREFIX)/share/sg-mail/$(EXT_ID).xpi
	install -D -m0644 launcher/user.js $(DESTDIR)$(PREFIX)/share/sg-mail/user.js
	install -D -m0644 data/sg-mail.desktop $(DESTDIR)$(PREFIX)/share/applications/sg-mail.desktop
	install -D -m0644 data/sg-mail.svg $(DESTDIR)$(PREFIX)/share/icons/hicolor/scalable/apps/sg-mail.svg
	for d in data/icons/*x*; do install -D -m0644 $$d/sg-mail.png $(DESTDIR)$(PREFIX)/share/icons/hicolor/$$(basename $$d)/apps/sg-mail.png; done
	install -D -m0644 data/org.stainedglass.SGMail.metainfo.xml $(DESTDIR)$(PREFIX)/share/metainfo/org.stainedglass.SGMail.metainfo.xml

lint:
	@sh -n launcher/sg-mail
	@for f in build/*.sh test/*.sh; do [ ! -f "$$f" ] || sh -n "$$f" || exit 1; done
	@node --check extension/background.js
	@node --check extension/experiments/parent.js
	@for f in extension/ui/js/*.js; do node --experimental-default-type=module --check $$f || exit 1; done
	@$(PY) -c 'import json,sys; [json.load(open(f)) for f in sys.argv[1:]]' extension/manifest.json extension/experiments/schema.json
	@$(PY) tools/check-schema.py extension/experiments/schema.json extension/experiments/parent.js
	@$(PY) -m py_compile test/lib/*.py test/gate/*.py test/servers/*.py tools/*.py
	@desktop-file-validate data/sg-mail.desktop
	@appstreamcli validate --no-net --pedantic data/org.stainedglass.SGMail.metainfo.xml >/dev/null
	@$(PY) tools/trademark-check.py extension data debian/control launcher
	@echo "lint: OK"

$(ROOT)/usr/bin/thunderbird:
	sh build/mkroot.sh $(ROOT)
root: $(ROOT)/usr/bin/thunderbird

test: lint xpi root
	@rc=0; for g in $(GATES); do echo "== $$g"; $(INROOT) $(PY) -u $$g || rc=1; done; exit $$rc

test-mutation: xpi root
	@$(PY) test/mutate.py $(GATES)

deb:
	dpkg-buildpackage -us -uc -b

clean:
	rm -rf build/out
