// ==UserScript==
// @name         Royal Road Foldable Chapter UI
// @namespace    https://github.com/royal-road-foldable-ui
// @version      1.0.3
// @description  Displays Royal Road chapters as two-column, page-flippable spreads on foldable phones in landscape mode.
// @match        https://www.royalroad.com/fiction/*/chapter/*
// @match        https://royalroad.com/fiction/*/chapter/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    const ACTIVE_BODY_CLASS = "rrf-foldable-active";
    const ACTIVE_CONTENT_CLASS = "rrf-foldable-content";
    const CONTROLS_ID = "rrf-foldable-controls";
    const STYLE_ID = "rrf-foldable-styles";
    const TITLE_CLASS = "rrf-foldable-title";
    const AUTHOR_NOTE_CLASS = "rrf-foldable-author-note";
    const NEXT_CHAPTER_CLASS = "rrf-foldable-next-chapter";
    const HIDDEN_HEADER_CLASS = "rrf-foldable-hidden-header";
    const TOUCH_TARGETS_ID = "rrf-foldable-touch-targets";
    const HIDDEN_FEEDBACK_CLASS = "rrf-foldable-hidden-feedback";
    const MOBILE_LANDSCAPE_QUERY =
        "(orientation: landscape) and (min-width: 600px) and (max-width: 1000px)";

    let contentElement = null;
    let controlsElement = null;
    let titleElement = null;
    let authorNoteElements = [];
    let authorNoteSources = new Map();
    let nextChapterElement = null;
    let nextChapterSource = null;
    let nextChapterObserver = null;
    let siteHeaderElement = null;
    let touchTargetsElement = null;
    let feedbackElement = null;
    let readerColors = null;
    let originalReaderColorProperties = null;
    let pageIndex = 0;
    let pageCount = 1;
    let resizeTimer = null;
    let refreshTimer = null;
    let navigationFrame = null;
    let touchStartX = null;
    let touchStartY = null;
    let readerSuspended = false;
    // Content position of the current page, captured on every user-initiated
    // page change while the layout is known to be valid. Used to keep the
    // reader on the same content across reflows and when leaving the reader.
    let lastReaderPosition = null;
    let cancelPendingDocumentScroll = null;
    // Content at the top of the normal page, sampled when scrolling stops.
    // A viewport change keeps scrollY but reflows the text, so by the time the
    // reader activates the content under the header has already moved; this
    // remembers what the user was actually looking at. `width` tags the
    // sample so ones taken mid-resize can be rejected.
    let documentPositionSample = null;
    let documentScrollTimer = null;
    let suppressScrollSamplingUntil = 0;

    function isSupportedViewport() {
        return window.matchMedia(MOBILE_LANDSCAPE_QUERY).matches;
    }

    function findChapterContent() {
        const preferred = document.querySelector(".chapter-content");
        if (preferred instanceof HTMLElement && preferred.textContent.trim()) {
            return preferred;
        }

        const fallback = document.querySelector(".chapter-inner");
        return fallback instanceof HTMLElement && fallback.textContent.trim()
            ? fallback
            : null;
    }

    function getChapterTitle() {
        const heading = document.querySelector(
            ".chapter-title, .chapter-header h1, h1"
        );
        if (heading instanceof HTMLElement && heading.textContent.trim()) {
            return heading.textContent.trim();
        }

        return document.title.split("|")[0].trim();
    }

    function findChapterLink(direction) {
        const labelPattern =
            direction === "next"
                ? /\bnext(?:\s+chapter)?\b/i
                : /\b(previous|prev)(?:\s+chapter)?\b/i;

        const chapterLinks = [];
        for (const element of document.querySelectorAll(
            "[href*='/chapter/'], [data-href*='/chapter/'], [data-url*='/chapter/']"
        )) {
            const target =
                element.getAttribute("href") ||
                element.getAttribute("data-href") ||
                element.getAttribute("data-url");
            if (!target) {
                continue;
            }

            const href = new URL(target, window.location.origin).href;
            const label = [
                element.textContent,
                element.getAttribute("aria-label"),
                element.getAttribute("title")
            ]
                .filter(Boolean)
                .join(" ");

            if (labelPattern.test(label)) {
                return href;
            }
            if (
                element
                    .getAttribute("rel")
                    ?.split(/\s+/)
                    .includes(direction === "next" ? "next" : "prev")
            ) {
                return href;
            }
            chapterLinks.push(href);
        }

        const currentChapterId = Number(
            window.location.pathname.match(/\/chapter\/(\d+)/)?.[1]
        );
        if (!currentChapterId) {
            return null;
        }

        const candidates = [...new Set(chapterLinks)]
            .map((href) => ({
                href,
                id: Number(new URL(href).pathname.match(/\/chapter\/(\d+)/)?.[1])
            }))
            .filter(({ id }) => Number.isFinite(id) && id !== currentChapterId)
            .sort((first, second) => first.id - second.id);

        if (direction === "next") {
            return candidates.find(({ id }) => id > currentChapterId)?.href || null;
        }

        return [...candidates]
            .reverse()
            .find(({ id }) => id < currentChapterId)?.href || null;
    }

    function addChapterTitle() {
        if (!contentElement || titleElement) {
            return;
        }

        const title = getChapterTitle();
        if (!title) {
            return;
        }

        const header = document.createElement("header");
        header.className = TITLE_CLASS;
        const heading = document.createElement("h1");
        heading.textContent = title;
        header.appendChild(heading);
        contentElement.prepend(header);
        titleElement = header;
    }

    function isAuthorNote(element) {
        return /\b(?:author'?s?\s+note|note\s+from)\b/i.test(
            element.textContent
        );
    }

    function findAuthorNotes(content) {
        const containers = [
            content.parentElement,
            content.parentElement?.parentElement
        ].filter(Boolean);

        for (const container of containers) {
            const notes = [...container.children].filter(
                (element) =>
                    element !== content &&
                    !element.contains(content) &&
                    isAuthorNote(element)
            );
            if (notes.length) {
                return notes;
            }
        }

        return [];
    }

    function containsOtherRoyalRoadFictionLink(note) {
        const currentFictionId = window.location.pathname.match(
            /^\/fiction\/(\d+)/
        )?.[1];

        return [...note.querySelectorAll("a[href]")].some((link) => {
            if (!link.textContent.trim()) {
                return false;
            }

            const destination = new URL(link.href);
            const fictionId = destination.pathname.match(/^\/fiction\/(\d+)/)?.[1];

            return (
                /^(?:www\.)?royalroad\.com$/i.test(destination.hostname) &&
                fictionId &&
                fictionId !== currentFictionId
            );
        });
    }

    function createAuthorNote(note) {
        const details = document.createElement("details");
        details.className = AUTHOR_NOTE_CLASS;
        details.open = !containsOtherRoyalRoadFictionLink(note);

        const summary = document.createElement("summary");
        summary.textContent = "Author note";
        details.appendChild(summary);

        const noteContent = note.cloneNode(true);
        noteContent.removeAttribute("id");
        for (const elementWithId of noteContent.querySelectorAll("[id]")) {
            elementWithId.removeAttribute("id");
        }
        details.appendChild(noteContent);

        return details;
    }

    function addAuthorNotes() {
        if (!contentElement || authorNoteElements.length) {
            return;
        }

        const notes = findAuthorNotes(contentElement);
        const before = [];
        const after = [];

        for (const note of notes) {
            const readerNote = createAuthorNote(note);
            authorNoteSources.set(readerNote, note);
            // Expanding/collapsing a note reflows the columns.
            readerNote.addEventListener("toggle", () => recalculatePages(false));
            if (note.compareDocumentPosition(contentElement) & Node.DOCUMENT_POSITION_FOLLOWING) {
                before.push(readerNote);
            } else {
                after.push(readerNote);
            }
        }

        for (const note of before.reverse()) {
            contentElement.prepend(note);
        }
        for (const note of after) {
            if (
                nextChapterElement &&
                nextChapterElement.parentElement === contentElement
            ) {
                contentElement.insertBefore(note, nextChapterElement);
            } else {
                contentElement.appendChild(note);
            }
        }

        authorNoteElements = [...before, ...after];
    }

    function findNextChapterWidget(content) {
        // Look directly for Royal Road's schedule banner (redesign or legacy alert).
        // Must be the banner itself, not a containing card or navigation portlet.
        const selectors = [
            "[class*='bg-info']",
            ".alert-info",
            "[class*='alert-info']",
            "[class*='next-chapter']"
        ];
        for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
                if (!(el instanceof HTMLElement)) {
                    continue;
                }
                if (
                    el === document.body ||
                    el === content ||
                    el.id === CONTROLS_ID ||
                    el.id === TOUCH_TARGETS_ID ||
                    el.classList.contains(NEXT_CHAPTER_CLASS) ||
                    el.classList.contains(AUTHOR_NOTE_CLASS) ||
                    (content && content.contains(el))
                ) {
                    continue;
                }

                const text = el.textContent || "";
                if (
                    /next\s+chapter\s*:/i.test(text) &&
                    el.querySelector("time") &&
                    !el.querySelector(
                        "a[href*='/chapter/'], select, button, .btn, #comments, [data-comment-id]"
                    )
                ) {
                    return el;
                }
            }
        }

        // Fallback: search upward from any <time> element that mentions "Next Chapter:".
        // Stop before outer container cards, navigation rows, or comment sections.
        for (const timeEl of document.querySelectorAll("time")) {
            if (content && content.contains(timeEl)) {
                continue;
            }
            let current = timeEl.parentElement;
            let candidate = null;
            while (current && current !== document.body && current !== content) {
                const text = current.textContent || "";
                if (/next\s+chapter\s*:/i.test(text)) {
                    if (
                        current.querySelector(
                            "a[href*='/chapter/'], select, button, .btn, #comments, [data-comment-id]"
                        )
                    ) {
                        break;
                    }
                    candidate = current;
                    if (
                        current.querySelector(
                            ".fa-clock, [class*='fa-clock'], [class*='clock']"
                        ) &&
                        current.querySelector("time")
                    ) {
                        return current;
                    }
                }
                current = current.parentElement;
            }
            if (candidate) {
                return candidate;
            }
        }

        return null;
    }

    function createNextChapterWidget(sourceWidget) {
        const widget = sourceWidget.cloneNode(true);
        for (const elementWithId of [widget, ...widget.querySelectorAll("[id]")]) {
            elementWithId.removeAttribute("id");
        }
        widget.classList.add(NEXT_CHAPTER_CLASS);
        return widget;
    }

    function addNextChapterWidget() {
        if (!contentElement || nextChapterElement) {
            return;
        }

        const sourceWidget = findNextChapterWidget(contentElement);
        if (!sourceWidget) {
            return;
        }

        nextChapterSource = sourceWidget;
        nextChapterElement = createNextChapterWidget(sourceWidget);
        contentElement.appendChild(nextChapterElement);

        nextChapterObserver = new MutationObserver(() => {
            if (!nextChapterElement || !sourceWidget) {
                return;
            }
            const sourceTimes = sourceWidget.querySelectorAll("time");
            const targetTimes = nextChapterElement.querySelectorAll("time");
            if (sourceTimes.length === targetTimes.length && sourceTimes.length > 0) {
                for (let i = 0; i < sourceTimes.length; i++) {
                    if (targetTimes[i].textContent !== sourceTimes[i].textContent) {
                        targetTimes[i].textContent = sourceTimes[i].textContent;
                    }
                }
            } else if (sourceWidget.textContent !== nextChapterElement.textContent) {
                nextChapterElement.innerHTML = sourceWidget.innerHTML;
                for (const el of nextChapterElement.querySelectorAll("[id]")) {
                    el.removeAttribute("id");
                }
            }
        });
        nextChapterObserver.observe(sourceWidget, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    function findSiteHeader() {
        const homeLink = [...document.querySelectorAll("a[href]")].find(
            (link) =>
                /^(?:https?:\/\/(?:www\.)?royalroad\.com)?\/?$/.test(
                    link.href
                ) &&
                (link.querySelector("img") || /royal\s+road/i.test(link.textContent))
        );
        const logo = homeLink
            ? homeLink
            : [...document.images].find((image) =>
                /royal\s*road/i.test(`${image.alt} ${image.src}`)
            );

        if (!logo) {
            return null;
        }

        for (
            let element = logo.parentElement;
            element && element !== document.body;
            element = element.parentElement
        ) {
            const bounds = element.getBoundingClientRect();
            if (
                bounds.top <= 10 &&
                bounds.height >= 40 &&
                bounds.height <= 200 &&
                bounds.width >= window.innerWidth * 0.75
            ) {
                return element;
            }
        }

        return null;
    }

    function hideSiteHeader() {
        siteHeaderElement = findSiteHeader();
        siteHeaderElement?.classList.add(HIDDEN_HEADER_CLASS);
    }

    function findFeedbackElement() {
        const candidates = document.querySelectorAll(
            "button, a, [role='button'], [class*='feedback'], [id*='feedback']"
        );

        for (const candidate of candidates) {
            const label = [
                candidate.textContent,
                candidate.getAttribute("aria-label"),
                candidate.getAttribute("title")
            ]
                .filter(Boolean)
                .join(" ");
            const bounds = candidate.getBoundingClientRect();

            if (
                /\bbeta\b|\bfeedback\b/i.test(label) &&
                bounds.width <= 160 &&
                bounds.height <= 160 &&
                bounds.right >= window.innerWidth - 160 &&
                bounds.bottom >= window.innerHeight - 160
            ) {
                return candidate;
            }
        }

        return null;
    }

    function hideFeedback() {
        feedbackElement = findFeedbackElement();
        feedbackElement?.classList.add(HIDDEN_FEEDBACK_CLASS);
    }

    function isTransparentColor(color) {
        return (
            color === "transparent" ||
            /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)$/.test(color)
        );
    }

    function applyReaderColors(content) {
        const foreground = window.getComputedStyle(content).color;
        let background = null;

        for (
            let element = content;
            element;
            element = element.parentElement
        ) {
            const candidate = window.getComputedStyle(element).backgroundColor;
            if (!isTransparentColor(candidate)) {
                background = candidate;
                break;
            }
        }

        readerColors = {
            background:
                background ||
                (window.matchMedia("(prefers-color-scheme: dark)").matches
                    ? "rgb(18, 18, 18)"
                    : "rgb(255, 255, 255)"),
            foreground
        };
        originalReaderColorProperties = {
            background: content.style.getPropertyValue("--rrf-page-background"),
            backgroundPriority: content.style.getPropertyPriority(
                "--rrf-page-background"
            ),
            foreground: content.style.getPropertyValue("--rrf-page-foreground"),
            foregroundPriority: content.style.getPropertyPriority(
                "--rrf-page-foreground"
            )
        };
        content.style.setProperty(
            "--rrf-page-background",
            readerColors.background
        );
        content.style.setProperty(
            "--rrf-page-foreground",
            readerColors.foreground
        );
    }

    function removeReaderColors() {
        if (!contentElement || !originalReaderColorProperties) {
            return;
        }

        const properties = [
            ["--rrf-page-background", "background", "backgroundPriority"],
            ["--rrf-page-foreground", "foreground", "foregroundPriority"]
        ];
        for (const [property, valueKey, priorityKey] of properties) {
            const value = originalReaderColorProperties[valueKey];
            if (value) {
                contentElement.style.setProperty(
                    property,
                    value,
                    originalReaderColorProperties[priorityKey]
                );
            } else {
                contentElement.style.removeProperty(property);
            }
        }

        readerColors = null;
        originalReaderColorProperties = null;
    }

    function addStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            body.${ACTIVE_BODY_CLASS} {
                overflow: hidden !important;
            }

            body.${ACTIVE_BODY_CLASS} #header,
            body.${ACTIVE_BODY_CLASS} .navbar:not(#${CONTROLS_ID}),
            body.${ACTIVE_BODY_CLASS} .navbar-fixed-top {
                display: none !important;
            }

            .${HIDDEN_HEADER_CLASS} {
                display: none !important;
            }

            .${HIDDEN_FEEDBACK_CLASS} {
                display: none !important;
            }

            .${ACTIVE_CONTENT_CLASS} {
                background: var(--rrf-page-background) !important;
                box-sizing: border-box !important;
                color: var(--rrf-page-foreground) !important;
                height: 100dvh !important;
                inset: 0 !important;
                margin: 0 !important;
                max-height: 100dvh !important;
                max-width: none !important;
                overflow-x: hidden !important;
                overflow-y: hidden !important;
                padding: 3.75rem 1rem 4.5rem !important;
                position: fixed !important;
                column-count: 2 !important;
                column-fill: auto !important;
                column-gap: 2rem !important;
                column-rule: 1px solid rgba(128, 128, 128, 0.35) !important;
                scroll-behavior: auto !important;
                scroll-snap-type: none !important;
                scrollbar-width: none !important;
                touch-action: none !important;
                width: 100vw !important;
                z-index: 2147483645 !important;
            }

            .${ACTIVE_CONTENT_CLASS}::after {
                background: rgba(128, 128, 128, 0.35);
                bottom: 4.5rem;
                content: "";
                left: 50%;
                pointer-events: none;
                position: absolute;
                top: 3.75rem;
                width: 1px;
            }

            .${ACTIVE_CONTENT_CLASS}::-webkit-scrollbar {
                display: none;
            }

            .${ACTIVE_CONTENT_CLASS} > * {
                break-inside: avoid;
            }

            /* Let prose paragraphs split across columns/pages so a short
               paragraph doesn't get pushed to its own page ahead of a long one. */
            .${ACTIVE_CONTENT_CLASS} > p {
                break-inside: auto;
            }

            .${TITLE_CLASS} {
                background: var(--rrf-page-background);
                left: 1rem;
                overflow: hidden;
                position: absolute;
                right: 1rem;
                text-overflow: ellipsis;
                top: 1rem;
                white-space: nowrap;
                z-index: 1;
            }

            .${TITLE_CLASS} h1 {
                font: inherit;
                font-size: 1.1rem;
                font-weight: 700;
                margin: 0;
            }

            .${AUTHOR_NOTE_CLASS} {
                background: color-mix(
                    in srgb,
                    var(--rrf-page-foreground) 8%,
                    var(--rrf-page-background)
                );
                border: 1px solid
                    color-mix(in srgb, var(--rrf-page-foreground) 20%, transparent);
                border-radius: 0.4rem;
                break-inside: avoid;
                box-sizing: border-box;
                margin: 0 0 1rem;
                max-width: 100%;
                overflow: hidden;
                padding: 0.5rem 0.75rem;
                width: 100%;
            }

            .${AUTHOR_NOTE_CLASS} summary {
                cursor: pointer;
                font-weight: 700;
            }

            .${AUTHOR_NOTE_CLASS} > :not(summary) {
                box-sizing: border-box;
                margin-top: 0.75rem;
                max-width: 100%;
                width: auto !important;
            }

            .${AUTHOR_NOTE_CLASS} * {
                box-sizing: border-box;
                max-width: 100%;
            }

            .${NEXT_CHAPTER_CLASS} {
                background: color-mix(
                    in srgb,
                    var(--rrf-page-foreground) 8%,
                    var(--rrf-page-background)
                );
                border: 1px solid
                    color-mix(in srgb, var(--rrf-page-foreground) 20%, transparent);
                border-radius: 0.4rem;
                break-inside: avoid !important;
                box-sizing: border-box !important;
                margin: 1.5rem 0 1rem !important;
                max-width: 100% !important;
                overflow: hidden !important;
            }

            .${NEXT_CHAPTER_CLASS} * {
                box-sizing: border-box !important;
                max-width: 100% !important;
            }

            .${NEXT_CHAPTER_CLASS} [class*='text-info'],
            .${NEXT_CHAPTER_CLASS} i.fa-clock,
            .${NEXT_CHAPTER_CLASS} [class*='clock'] {
                flex-shrink: 0;
            }

            .${NEXT_CHAPTER_CLASS} .flex-grow {
                flex-grow: 1;
                min-width: 0;
            }

            #${TOUCH_TARGETS_ID} {
                bottom: 4rem;
                display: flex;
                left: 0;
                pointer-events: none;
                position: fixed;
                right: 0;
                top: 3.75rem;
                z-index: 2147483646;
            }

            #${TOUCH_TARGETS_ID} button {
                background: transparent;
                border: 0;
                flex: 0 0 14%;
                margin: 0;
                opacity: 0;
                padding: 0;
                pointer-events: auto;
                touch-action: none;
            }

            #${TOUCH_TARGETS_ID} .rrf-foldable-touch-spacer {
                flex: 1 1 auto;
                pointer-events: none;
            }

            #${CONTROLS_ID} {
                align-items: center;
                background: transparent;
                border: 0;
                bottom: 0;
                color: var(--rrf-page-foreground);
                display: flex;
                gap: 0.75rem;
                justify-content: center;
                left: 0;
                padding: 0.65rem 1rem;
                position: fixed;
                right: 0;
                z-index: 2147483647;
            }

            #${CONTROLS_ID} button {
                align-items: center;
                background: transparent;
                border: 1px solid transparent;
                border-radius: 0.4rem;
                color: inherit;
                display: inline-flex;
                font: inherit;
                justify-content: center;
                min-height: 2.75rem;
                min-width: 3.25rem;
                padding: 0.35rem 0.75rem;
                touch-action: manipulation;
            }

            #${CONTROLS_ID} a {
                align-items: center;
                border: 1px solid transparent;
                border-radius: 0.4rem;
                color: inherit;
                display: inline-flex;
                font: inherit;
                justify-content: center;
                min-height: 2.75rem;
                padding: 0.35rem 0.5rem;
                text-decoration: none;
                touch-action: manipulation;
            }

            #${CONTROLS_ID} button:active,
            #${CONTROLS_ID} button:focus-visible,
            #${CONTROLS_ID} a:active,
            #${CONTROLS_ID} a:focus-visible {
                background: color-mix(in srgb, currentColor 12%, transparent);
                border-color: color-mix(in srgb, currentColor 30%, transparent);
            }

            #rrf-foldable-page {
                color: inherit;
                min-width: 5rem;
                text-align: center;
            }
        `;
        document.head.appendChild(style);
    }

    function updateControls() {
        if (!controlsElement) {
            return;
        }

        const pageLabel = controlsElement.querySelector("#rrf-foldable-page");
        const previousButton = controlsElement.querySelector("[data-direction='previous']");
        const nextButton = controlsElement.querySelector("[data-direction='next']");

        if (pageLabel) {
            pageLabel.textContent = `Page ${pageIndex + 1} of ${pageCount}`;
        }
        if (previousButton instanceof HTMLButtonElement) {
            previousButton.disabled = pageIndex === 0;
        }
        if (nextButton instanceof HTMLButtonElement) {
            nextButton.disabled = pageIndex >= pageCount - 1;
        }
    }

    function createTouchTargets() {
        const targets = document.createElement("div");
        targets.id = TOUCH_TARGETS_ID;
        targets.setAttribute("aria-label", "Page turn touch targets");
        targets.innerHTML = `
            <button type="button" data-direction="previous" aria-label="Previous page"></button>
            <span class="rrf-foldable-touch-spacer" aria-hidden="true"></span>
            <button type="button" data-direction="next" aria-label="Next page"></button>
        `;
        targets.addEventListener("click", (event) => {
            const button =
                event.target instanceof Element
                    ? event.target.closest("button[data-direction]")
                    : null;
            if (!button) {
                return;
            }
            goToPage(pageIndex + (button.dataset.direction === "next" ? 1 : -1));
        });
        document.body.appendChild(targets);
        touchTargetsElement = targets;
    }

    function goToPage(nextIndex, behavior = "smooth") {
        if (!contentElement) {
            return;
        }

        pageIndex = Math.max(0, Math.min(nextIndex, pageCount - 1));
        // The capture uses pageIndex (not scrollLeft), so it is valid even
        // before the smooth scroll reaches the target page.
        lastReaderPosition = captureReaderPosition();
        contentElement.scrollTo({
            left: pageIndex * contentElement.clientWidth,
            behavior
        });
        updateControls();
    }

    function findPageForPosition(position) {
        if (
            !contentElement ||
            !position ||
            !position.node.isConnected ||
            !contentElement.contains(position.node)
        ) {
            return null;
        }

        let rect = null;
        if (position.node.nodeType === Node.TEXT_NODE) {
            const length = position.node.data.length;
            const range = document.createRange();
            range.setStart(position.node, Math.min(position.offset, length));
            range.setEnd(position.node, Math.min(position.offset + 1, length));
            rect = range.getBoundingClientRect();
        } else {
            rect = position.node.getBoundingClientRect();
        }
        if (!rect.width && !rect.height) {
            return null;
        }

        const contentX =
            rect.left -
            contentElement.getBoundingClientRect().left +
            contentElement.scrollLeft;
        return Math.floor(contentX / contentElement.clientWidth);
    }

    function recalculatePages(resetToStart) {
        if (!contentElement || contentElement.clientWidth === 0) {
            return;
        }

        pageCount = Math.max(
            1,
            Math.ceil(contentElement.scrollWidth / contentElement.clientWidth)
        );
        // Open on the page holding the tracked content: after a reflow (resize,
        // image load, note toggle, ads) that is the page being read; on
        // activation it is whatever was at the top of the normal page.
        const restoredPage = findPageForPosition(lastReaderPosition);
        if (restoredPage !== null) {
            pageIndex = restoredPage;
        } else if (resetToStart) {
            pageIndex = 0;
        }
        pageIndex = Math.max(0, Math.min(pageIndex, pageCount - 1));

        const targetLeft = pageIndex * contentElement.clientWidth;
        // Only snap if we are off a page boundary; unconditionally assigning
        // scrollLeft here would cancel in-flight smooth page turns whenever
        // unrelated DOM mutations (ads, comments) trigger a refresh.
        if (Math.abs(contentElement.scrollLeft - targetLeft) > 1) {
            contentElement.scrollLeft = targetLeft;
        }
        if (resetToStart || lastReaderPosition === null) {
            lastReaderPosition = captureReaderPosition();
        }
        updateControls();
    }

    function watchContentImages() {
        if (!contentElement) {
            return;
        }

        for (const image of contentElement.querySelectorAll("img")) {
            if (!image.complete) {
                image.addEventListener("load", () => recalculatePages(false), {
                    once: true
                });
            }
        }
    }

    function createControls() {
        const controls = document.createElement("nav");
        controls.id = CONTROLS_ID;
        controls.setAttribute("aria-label", "Chapter pages");
        if (readerColors) {
            controls.style.setProperty(
                "--rrf-page-background",
                readerColors.background
            );
            controls.style.setProperty(
                "--rrf-page-foreground",
                readerColors.foreground
            );
        }
        controls.innerHTML = `
            <button type="button" data-direction="previous" aria-label="Previous page">‹</button>
            <span id="rrf-foldable-page" aria-live="polite"></span>
            <button type="button" data-direction="next" aria-label="Next page">›</button>
        `;
        const previousChapter = findChapterLink("previous");
        const nextChapter = findChapterLink("next");

        if (previousChapter) {
            const previousLink = document.createElement("a");
            previousLink.href = previousChapter;
            previousLink.textContent = "Previous chapter";
            previousLink.setAttribute("aria-label", "Previous chapter");
            controls.prepend(previousLink);
        }
        if (nextChapter) {
            const nextLink = document.createElement("a");
            nextLink.href = nextChapter;
            nextLink.textContent = "Next chapter";
            nextLink.setAttribute("aria-label", "Next chapter");
            controls.appendChild(nextLink);
        }
        controls.addEventListener("click", (event) => {
            const button =
                event.target instanceof Element
                    ? event.target.closest("button[data-direction]")
                    : null;
            if (!button) {
                return;
            }
            goToPage(pageIndex + (button.dataset.direction === "next" ? 1 : -1));
        });
        document.body.appendChild(controls);
        controlsElement = controls;
    }

    function handleKeydown(event) {
        if (!contentElement || event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }

        if (event.key === "ArrowRight" || event.key === "PageDown") {
            event.preventDefault();
            goToPage(pageIndex + 1);
        } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
            event.preventDefault();
            goToPage(pageIndex - 1);
        } else if (event.key === "Home") {
            event.preventDefault();
            goToPage(0);
        } else if (event.key === "End") {
            event.preventDefault();
            goToPage(pageCount - 1);
        }
    }

    function handleScroll() {
        if (!contentElement || navigationFrame !== null) {
            return;
        }

        navigationFrame = window.requestAnimationFrame(() => {
            navigationFrame = null;
            if (!contentElement || contentElement.clientWidth === 0) {
                return;
            }

            const width = contentElement.clientWidth;
            const nearestPage = Math.round(contentElement.scrollLeft / width);
            // Ignore intermediate positions of a smooth scroll; otherwise a
            // second tap mid-animation would re-target the page we just left.
            if (Math.abs(contentElement.scrollLeft - nearestPage * width) > 1) {
                return;
            }
            pageIndex = Math.max(0, Math.min(pageCount - 1, nearestPage));
            updateControls();
        });
    }

    function handleTouchStart(event) {
        if (event.touches.length !== 1) {
            touchStartX = null;
            touchStartY = null;
            return;
        }

        touchStartX = event.touches[0].clientX;
        touchStartY = event.touches[0].clientY;
    }

    function handleTouchEnd(event) {
        if (
            touchStartX === null ||
            touchStartY === null ||
            event.changedTouches.length !== 1
        ) {
            touchStartX = null;
            touchStartY = null;
            return;
        }

        const touch = event.changedTouches[0];
        const horizontalDistance = touch.clientX - touchStartX;
        const verticalDistance = touch.clientY - touchStartY;
        const isHorizontalSwipe =
            Math.abs(horizontalDistance) >= 40 &&
            Math.abs(horizontalDistance) > Math.abs(verticalDistance);
        const isVerticalSwipe =
            Math.abs(verticalDistance) >= 40 &&
            Math.abs(verticalDistance) > Math.abs(horizontalDistance);

        if (isHorizontalSwipe) {
            event.preventDefault();
            goToPage(
                pageIndex + (horizontalDistance < 0 ? 1 : -1),
                "auto"
            );
        } else if (isVerticalSwipe) {
            event.preventDefault();
            leaveReader(verticalDistance < 0 ? "next" : "previous");
        }

        touchStartX = null;
        touchStartY = null;
    }

    function handleTouchCancel() {
        touchStartX = null;
        touchStartY = null;
    }

    function findCommentSection() {
        // Royal Road: `<a id="comments">` is an empty anchor; the visible block is
        // `.portlet.comments-container`, whose `#comment-loader` is lazily filled by
        // the site's own IntersectionObserver once it scrolls into view.
        const knownContainer = document.querySelector(
            ".comments-container, #comments-container, #chapter-comments, .chapter-comments, [data-comment-section]"
        );
        if (knownContainer) {
            return knownContainer;
        }

        const loader = document.querySelector("#comment-loader, .comment-container");
        if (loader) {
            return loader.closest(".portlet, section") || loader;
        }

        const anchor = document.querySelector("#comments");
        if (anchor) {
            return anchor.nextElementSibling || anchor;
        }

        const heading = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].find(
            (element) => /^comments(?:\s*\(\d+\))?$/i.test(element.textContent.trim())
        );
        return heading?.closest("section, .portlet, .panel, div") || heading || null;
    }

    const ATOMIC_ELEMENT_PATTERN = /^(?:img|video|iframe|hr|canvas|svg|picture)$/i;

    function getNodeFragmentRects(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            const range = document.createRange();
            range.selectNodeContents(node);
            return range.getClientRects();
        }
        if (node instanceof Element) {
            return node.getClientRects();
        }
        return [];
    }

    function mapReaderNodeToOriginal(node) {
        for (const [readerNote, originalNote] of authorNoteSources) {
            if (!readerNote.contains(node)) {
                continue;
            }

            const cloneRoot = readerNote.lastElementChild;
            if (!cloneRoot || !cloneRoot.contains(node)) {
                return { node: originalNote, offset: 0 };
            }

            const path = [];
            for (let current = node; current !== cloneRoot; current = current.parentNode) {
                path.unshift(
                    Array.prototype.indexOf.call(current.parentNode.childNodes, current)
                );
            }

            let target = originalNote;
            for (const index of path) {
                target = target.childNodes[index];
                if (!target) {
                    return { node: originalNote, offset: 0 };
                }
            }
            return { node: target, offset: 0 };
        }

        if (
            nextChapterElement &&
            nextChapterSource &&
            nextChapterElement.contains(node)
        ) {
            return { node: nextChapterSource, offset: 0 };
        }

        return { node, offset: 0 };
    }

    /**
     * Finds the first piece of content (text character or image) inside `root`
     * for which `rectMatches` holds. `elementIsBefore(bounds)` is a pre-filter
     * that lets whole subtrees be skipped. Content order must agree with the
     * geometric order implied by the predicates (true for normal flow).
     */
    function findFirstContentPosition(root, rectMatches, elementIsBefore) {
        const anyRectMatches = (rects) => {
            for (const rect of rects) {
                if (rect.width > 0 && rect.height > 0 && rectMatches(rect)) {
                    return true;
                }
            }
            return false;
        };

        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    if (node === titleElement) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    if (node.nodeType === Node.TEXT_NODE) {
                        return node.data.trim()
                            ? NodeFilter.FILTER_ACCEPT
                            : NodeFilter.FILTER_SKIP;
                    }
                    if (ATOMIC_ELEMENT_PATTERN.test(node.nodeName)) {
                        return NodeFilter.FILTER_ACCEPT;
                    }
                    // The bounding box is the union of all fragments (columns
                    // included), so a block that ends before the target region
                    // cannot contain anything in it: skip its subtree.
                    const bounds = node.getBoundingClientRect();
                    if (
                        (bounds.width > 0 || bounds.height > 0) &&
                        elementIsBefore(bounds)
                    ) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_SKIP;
                }
            }
        );

        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!anyRectMatches(getNodeFragmentRects(node))) {
                continue;
            }

            const position = mapReaderNodeToOriginal(node);
            if (position.node !== node || node.nodeType !== Node.TEXT_NODE) {
                return position;
            }

            // This text node straddles the boundary: binary-search the first
            // character whose line is inside the target region.
            const range = document.createRange();
            range.setStart(node, 0);
            let low = 1;
            let high = node.data.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                range.setEnd(node, middle);
                if (anyRectMatches(range.getClientRects())) {
                    high = middle;
                } else {
                    low = middle + 1;
                }
            }
            return { node, offset: Math.max(0, low - 1) };
        }

        return null;
    }

    /** First content on the current reader page (reader must be active). */
    function captureReaderPosition() {
        if (!contentElement || contentElement.clientWidth === 0) {
            return null;
        }

        const contentLeft = contentElement.getBoundingClientRect().left;
        const scrollLeft = contentElement.scrollLeft;
        const pageStart = pageIndex * contentElement.clientWidth - 1;
        const toContentX = (clientX) => clientX - contentLeft + scrollLeft;

        return findFirstContentPosition(
            contentElement,
            (rect) => toContentX(rect.left) >= pageStart,
            (bounds) => toContentX(bounds.right) < pageStart
        );
    }

    /**
     * First content visible below the header in the normal (non-reader)
     * layout, so the reader can open on the page the user was looking at.
     */
    function captureDocumentPosition(content) {
        // A line must show more than the 12px gap scrollDocumentTo() leaves
        // above the target line, so that leaving and re-entering the reader
        // round-trips to the same line.
        const topEdge = getFixedHeaderHeight() + 13;
        return findFirstContentPosition(
            content,
            (rect) => rect.bottom > topEdge,
            (bounds) => bounds.bottom <= topEdge
        );
    }

    function sampleDocumentPosition() {
        if (contentElement) {
            return;
        }
        if (
            documentPositionSample &&
            documentPositionSample.width !== window.innerWidth
        ) {
            // Viewport is changing; refresh()/activate() will reset sampling.
            return;
        }

        const content = findChapterContent();
        if (content) {
            documentPositionSample = {
                position: captureDocumentPosition(content),
                width: window.innerWidth
            };
        }
    }

    function takeDocumentPosition(content) {
        const sampled = documentPositionSample?.position;
        documentPositionSample = null;
        if (sampled && sampled.node.isConnected && content.contains(sampled.node)) {
            return sampled;
        }
        return captureDocumentPosition(content);
    }

    function getDocumentTop(node, offset) {
        if (!node || !node.isConnected) {
            return null;
        }

        let rect = null;
        if (node.nodeType === Node.TEXT_NODE) {
            const length = node.data.length;
            const range = document.createRange();
            range.setStart(node, Math.min(offset, length));
            range.setEnd(node, Math.min(offset + 1, length));
            rect = range.getBoundingClientRect();
            if (!rect.height) {
                rect = node.parentElement?.getBoundingClientRect() || null;
            }
        } else if (node instanceof Element) {
            rect = node.getBoundingClientRect();
        }

        if (!rect || (!rect.height && !rect.width)) {
            return null;
        }
        return rect.top + window.scrollY;
    }

    function getFixedHeaderHeight() {
        let height = 0;
        for (const element of document.querySelectorAll(
            ".page-header-top, .page-header-menu, .page-header, .navbar-fixed-top, header"
        )) {
            const position = window.getComputedStyle(element).position;
            if (position !== "fixed" && position !== "sticky") {
                continue;
            }
            const bounds = element.getBoundingClientRect();
            if (bounds.top <= 1 && bounds.height > 0 && bounds.height <= 200) {
                height = Math.max(height, bounds.bottom);
            }
        }
        return height;
    }

    /**
     * Scrolls the document so the position returned by `resolveTop` sits just
     * below any fixed header. The scroll is re-applied a few times to absorb
     * layout shifts (ads, lazily loaded comments, the header becoming fixed),
     * but gives up as soon as the user scrolls on their own.
     */
    function scrollDocumentTo(resolveTop) {
        let appliedTop = null;
        let finished = false;
        const appliedTargets = new Set();
        const timers = [];
        const apply = () => {
            if (
                finished ||
                (appliedTop !== null && Math.abs(window.scrollY - appliedTop) > 2)
            ) {
                finished = true;
                return;
            }

            const top = resolveTop();
            if (top === null) {
                return;
            }

            const target = Math.max(
                0,
                Math.round(top - getFixedHeaderHeight() - 12)
            );
            if (appliedTargets.has(target)) {
                // A layout that reacts to scrolling (e.g. a header that becomes
                // fixed) is bouncing the target around; settle where we are.
                finished = true;
                return;
            }
            appliedTargets.add(target);

            window.scrollTo({ top: target, left: 0, behavior: "instant" });
            appliedTop = window.scrollY;
            // Our own scroll events must not replace the exact position sample.
            suppressScrollSamplingUntil = performance.now() + 300;
        };

        cancelPendingDocumentScroll?.();
        window.requestAnimationFrame(() => window.requestAnimationFrame(apply));
        for (const delay of [250, 750, 1500]) {
            timers.push(window.setTimeout(apply, delay));
        }
        cancelPendingDocumentScroll = () => {
            finished = true;
            for (const timer of timers) {
                window.clearTimeout(timer);
            }
            cancelPendingDocumentScroll = null;
        };
    }

    function leaveReader(direction) {
        if (!contentElement) {
            return;
        }

        const goToComments = direction === "next" && pageIndex >= pageCount - 1;
        const position = goToComments ? null : captureReaderPosition();

        readerSuspended = true;
        deactivate();

        if (goToComments) {
            scrollDocumentTo(() => {
                const section = findCommentSection();
                return section
                    ? getDocumentTop(section, 0)
                    : document.documentElement.scrollHeight;
            });
        } else {
            scrollToReaderPosition(position);
        }
    }

    function scrollToReaderPosition(position) {
        if (!position) {
            return;
        }
        scrollDocumentTo(() => getDocumentTop(position.node, position.offset));
        // Remember the exact position rather than re-deriving it from the
        // scrolled geometry later, so re-entering the reader (unfolding)
        // returns to the same page even when it sits on a page boundary.
        documentPositionSample = { position, width: window.innerWidth };
    }

    function activate(content) {
        if (contentElement === content) {
            let changed = false;
            if (
                !authorNoteElements.length &&
                findAuthorNotes(contentElement).length > 0
            ) {
                addAuthorNotes();
                changed = true;
            }
            if (!nextChapterElement && findNextChapterWidget(contentElement)) {
                addNextChapterWidget();
                changed = true;
            }
            if (changed) {
                recalculatePages(false);
            }
            return;
        }

        deactivate();
        // Work out which content is at the top of the screen, then reset the
        // document scroll before taking the chapter out of the flow. Leaving
        // the document scrolled deep (e.g. after reading in portrait) while
        // the page collapses to header + footer is what let the footer show
        // through on Firefox for Android; a fresh load never has this problem.
        const documentPosition = takeDocumentPosition(content);
        cancelPendingDocumentScroll?.();
        window.scrollTo({ top: 0, left: 0, behavior: "instant" });
        addStyles();
        contentElement = content;
        applyReaderColors(contentElement);
        contentElement.classList.add(ACTIVE_CONTENT_CLASS);
        document.body.classList.add(ACTIVE_BODY_CLASS);
        hideSiteHeader();
        hideFeedback();
        addChapterTitle();
        addAuthorNotes();
        addNextChapterWidget();
        createTouchTargets();
        createControls();
        watchContentImages();
        contentElement.addEventListener("scroll", handleScroll, { passive: true });
        // Swipes are also recognised on the edge touch targets, otherwise a
        // vertical swipe starting near either edge would be swallowed.
        for (const element of [contentElement, touchTargetsElement]) {
            element.addEventListener("touchstart", handleTouchStart, {
                passive: true
            });
            element.addEventListener("touchend", handleTouchEnd, {
                passive: false
            });
            element.addEventListener("touchcancel", handleTouchCancel, {
                passive: true
            });
        }
        document.addEventListener("keydown", handleKeydown);
        pageIndex = 0;
        lastReaderPosition = documentPosition;
        window.requestAnimationFrame(() => recalculatePages(true));
    }

    function deactivate() {
        if (contentElement) {
            contentElement.classList.remove(ACTIVE_CONTENT_CLASS);
            contentElement.removeEventListener("scroll", handleScroll);
            contentElement.removeEventListener("touchstart", handleTouchStart);
            contentElement.removeEventListener("touchend", handleTouchEnd);
            contentElement.removeEventListener("touchcancel", handleTouchCancel);
        }
        if (controlsElement) {
            controlsElement.remove();
        }
        if (touchTargetsElement) {
            touchTargetsElement.remove();
        }
        if (titleElement) {
            titleElement.remove();
        }
        siteHeaderElement?.classList.remove(HIDDEN_HEADER_CLASS);
        feedbackElement?.classList.remove(HIDDEN_FEEDBACK_CLASS);
        for (const authorNoteElement of authorNoteElements) {
            authorNoteElement.remove();
        }
        authorNoteSources = new Map();
        if (nextChapterElement) {
            nextChapterElement.remove();
        }
        if (nextChapterObserver) {
            nextChapterObserver.disconnect();
            nextChapterObserver = null;
        }
        nextChapterElement = null;
        nextChapterSource = null;
        document.body.classList.remove(ACTIVE_BODY_CLASS);
        document.removeEventListener("keydown", handleKeydown);
        removeReaderColors();
        contentElement = null;
        controlsElement = null;
        touchTargetsElement = null;
        feedbackElement = null;
        titleElement = null;
        authorNoteElements = [];
        siteHeaderElement = null;
        pageIndex = 0;
        pageCount = 1;
    }

    function refresh() {
        if (isCommentLink()) {
            readerSuspended = false;
            deactivate();
            return;
        }

        if (!isSupportedViewport()) {
            // Folding the phone / rotating to portrait leaves the reader too:
            // land on the content that was being read, not the page top.
            readerSuspended = false;
            if (contentElement) {
                const position = lastReaderPosition;
                deactivate();
                documentPositionSample = null;
                scrollToReaderPosition(position);
            }
            return;
        }

        if (readerSuspended) {
            return;
        }

        const chapterContent = findChapterContent();
        if (chapterContent) {
            activate(chapterContent);
        } else {
            deactivate();
        }
    }

    function scheduleRefresh() {
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(refresh, 100);
    }

    function isCommentLink() {
        // Royal Road links to comments with either ?comment=<id> or #comment-<id>.
        return (
            new URL(window.location.href).searchParams.has("comment") ||
            /^#comment-/.test(window.location.hash)
        );
    }

    window.addEventListener("resize", () => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
            if (contentElement && isSupportedViewport()) {
                recalculatePages(false);
            } else {
                refresh();
            }
        }, 150);
    });
    window.addEventListener(
        "scroll",
        () => {
            if (contentElement) {
                return;
            }
            window.clearTimeout(documentScrollTimer);
            if (performance.now() < suppressScrollSamplingUntil) {
                return;
            }
            documentScrollTimer = window.setTimeout(sampleDocumentPosition, 150);
        },
        { passive: true }
    );
    window.addEventListener("orientationchange", scheduleRefresh);
    window.addEventListener("popstate", scheduleRefresh);
    document.addEventListener("DOMContentLoaded", refresh, { once: true });
    new MutationObserver((mutations) => {
        if (
            mutations.some(
                (mutation) =>
                    !controlsElement ||
                    !controlsElement.contains(mutation.target)
            )
        ) {
            scheduleRefresh();
        }
    }).observe(document.documentElement, {
        childList: true,
        subtree: true
    });
    refresh();
})();