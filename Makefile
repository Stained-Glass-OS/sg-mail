# SG Mail -- Stained Glass OS's mail and calendar: Thunderbird (Mozilla's,
# unmodified) underneath, our window on top (a Thunderbird extension).
#
#   make xpi            the extension             -> build/out/sg-mail@stained-glass-os.org.xpi
#   make install        lay it out under DESTDIR (/usr/bin/sg-mail, /usr/share/sg-mail, ...)
#   make lint           syntax, manifests, desktop entry, AppStream, trademarks
#   make test           lint + every gate (test/gate/*.py) in the test root
#   make test-mutation  each gate against its mutants: it must fail
#   tools/gen-icons.py  the hicolor PNGs (data/icons) from data/sg-mail.svg
#   make deb            the package sg-mail       -> ../sg-mail_*_all.deb
#   make root           the test root (Debian trixie: Thunderbird, Xvfb,
#                       Dovecot, Radicale, aiosmtpd), made once, rootless
#   make test TB_DEB=.. the gates against that thunderbird package (Stained
#                       Glass OS's, Mozilla's build), in a root of its own
#
# The gates run Thunderbird with local stand-in servers only, in a network
# namespace of their own: nothing reaches a real mail provider.
EXT_ID   = sg-mail@stained-glass-os.org
OUT     ?= build/out
XPI      = $(OUT)/$(EXT_ID).xpi
DESTDIR ?=
PREFIX  ?= /usr
# TB_DEB=path/thunderbird_*.deb: the gates against that Thunderbird package
# (sg-image's, Mozilla's build) put over Debian's, in a root of its own
TB_DEB  ?=
# ROOT_REV: a new name whenever build/mkroot.sh's packages change (an older
# root stays usable for checkouts that still want it)
ROOT_REV = r3
ifneq ($(TB_DEB),)
ROOT    ?= /var/tmp/sgmail/root-tb-$(ROOT_REV)-$(shell dpkg-deb -f $(TB_DEB) Version | tr : _)
else
ROOT    ?= /var/tmp/sgmail/root-tb-$(ROOT_REV)
endif
PY      ?= python3
GATES   ?= $(sort $(wildcard test/gate/*-gate.py))
# the package as installed (make stage), laid over the test root's /usr; with
# DavMail (sg-image's sg-davmail package: SG_DAVMAIL_DEB) for the davmail gates
STAGE   ?= $(CURDIR)/build/stage
SG_DAVMAIL_DEB ?= $(lastword $(sort $(wildcard ../sg-image/build/davmail-deb/sg-davmail_*_all.deb)))
# the davmail gates: a network card that leads nowhere (DavMail tells "no
# network" from "not signed in" by it) and a systemd user manager of their own
INROOT   = SG_NONET=$$(case $$g in *davmail*) echo lan;; *) echo 1;; esac) SG_STAGE=$(STAGE) SG_ROOT=$(ROOT) SG_CWD=$(CURDIR) sh build/inroot.sh

.PHONY: all xpi install lint test test-mutation deb root clean stage
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
	install -D -m0644 launcher/userChrome.css $(DESTDIR)$(PREFIX)/share/sg-mail/userChrome.css
	install -D -m0755 launcher/sg-mail-davmail $(DESTDIR)$(PREFIX)/lib/sg-mail/sg-mail-davmail
	install -D -m0644 data/sg-mail-davmail@.service $(DESTDIR)$(PREFIX)/lib/systemd/user/sg-mail-davmail@.service
	install -D -m0644 data/sg-mail.desktop $(DESTDIR)$(PREFIX)/share/applications/sg-mail.desktop
	install -D -m0644 data/sg-mail.svg $(DESTDIR)$(PREFIX)/share/icons/hicolor/scalable/apps/sg-mail.svg
	for d in data/icons/*x*; do install -D -m0644 $$d/sg-mail.png $(DESTDIR)$(PREFIX)/share/icons/hicolor/$$(basename $$d)/apps/sg-mail.png; done
	install -D -m0644 data/org.stainedglass.SGMail.metainfo.xml $(DESTDIR)$(PREFIX)/share/metainfo/org.stainedglass.SGMail.metainfo.xml

lint:
	@sh -n launcher/sg-mail
	@sh -n launcher/sg-mail-davmail
	@if command -v shellcheck >/dev/null; then shellcheck -s sh launcher/sg-mail-davmail build/inroot.sh; fi
	@SYSTEMD_LOG_LEVEL=err systemd-analyze --user verify --man=no --recursive-errors=no data/sg-mail-davmail@.service 2>&1 | grep -v 'Command /usr/lib/sg-mail/sg-mail-davmail is not executable' | grep . && exit 1 || :
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
	sh build/mkroot.sh $(ROOT) $(TB_DEB)
root: $(ROOT)/usr/bin/thunderbird

stage: xpi
	@rm -rf $(STAGE)
	@$(MAKE) -s install DESTDIR=$(STAGE) >/dev/null
	@if [ -n "$(SG_DAVMAIL_DEB)" ]; then dpkg-deb -x $(SG_DAVMAIL_DEB) $(STAGE); \
	  else echo "no sg-davmail package (SG_DAVMAIL_DEB; sg-image: make davmail-pkg): the davmail gates will fail"; fi

# the gates run the extension packed, as the package installs it
test: lint xpi root stage
	@sh test/launcher-gate.sh
	@sh test/icons-gate.sh
	@rc=0; for g in $(GATES); do echo "== $$g"; SG_MAIL_EXTENSION=xpi $(INROOT) $(PY) -u $$g || rc=1; done; exit $$rc

test-mutation: xpi root stage
	@sh test/launcher-gate.sh --mutants
	@sh test/icons-gate.sh --mutants
	@SG_ROOT=$(ROOT) SG_STAGE=$(STAGE) $(PY) test/mutate.py $(GATES)

deb:
	dpkg-buildpackage -us -uc -b

clean:
	rm -rf build/out
