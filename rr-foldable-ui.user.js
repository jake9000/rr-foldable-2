// ==UserScript==
// @name         Royal Road Foldable Chapter UI
// @namespace    https://github.com/royal-road-foldable-ui
// @version      1.0.0
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
    const HIDDEN_HEADER_CLASS = "rrf-foldable-hidden-header";
    const MOBILE_LANDSCAPE_QUERY =
        "(orientation: landscape) and (min-width: 600px) and (max-width: 1000px)";

    let contentElement = null;
    let controlsElement = null;
    let titleElement = null;
    let authorNoteElements = [];
    let siteHeaderElement = null;
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
            contentElement.appendChild(note);
        }

        authorNoteElements = [...before, ...after];
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
                z-index: 2147483646 !important;
            }

            .${ACTIVE_CONTENT_CLASS}::-webkit-scrollbar {
                display: none;
            }

            .${ACTIVE_CONTENT_CLASS} > * {
                break-inside: avoid;
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

    function goToPage(nextIndex, behavior = "smooth") {
        if (!contentElement) {
            return;
        }

        pageIndex = Math.max(0, Math.min(nextIndex, pageCount - 1));
        contentElement.scrollTo({
            left: pageIndex * contentElement.clientWidth,
            behavior
        });
        updateControls();
    }

    function recalculatePages(resetToStart) {
        if (!contentElement || contentElement.clientWidth === 0) {
            return;
        }

        pageCount = Math.max(
            1,
            Math.ceil(contentElement.scrollWidth / contentElement.clientWidth)
        );
        pageIndex = Math.min(resetToStart ? 0 : pageIndex, pageCount - 1);
        contentElement.scrollLeft = pageIndex * contentElement.clientWidth;
        updateControls();
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
            pageIndex = Math.max(
                0,
                Math.min(
                    pageCount - 1,
                    Math.round(contentElement.scrollLeft / contentElement.clientWidth)
                )
            );
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
        const knownContainer = document.querySelector(
            "#comments, #comments-container, #chapter-comments, .comments-container, .chapter-comments, [data-comment-section], #comment-loader"
        );
        if (knownContainer) {
            return knownContainer;
        }

        const heading = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].find(
            (element) => /^comments(?:\s*\(\d+\))?$/i.test(element.textContent.trim())
        );
        return heading?.closest("section, .portlet, .panel, div") || heading || null;
    }

    function scrollToDocumentTarget(target, direction) {
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                if (target instanceof HTMLElement && document.contains(target)) {
                    window.scrollTo({
                        top: Math.max(
                            0,
                            target.getBoundingClientRect().top +
                                window.scrollY -
                                12
                        ),
                        left: 0,
                        behavior: "auto"
                    });
                } else if (direction === "next") {
                    window.scrollTo({
                        top: document.documentElement.scrollHeight,
                        left: 0,
                        behavior: "auto"
                    });
                }
            });
        });
    }

    function waitForCommentsAndScroll(loader, direction) {
        let finished = false;
        let observer = null;
        const finish = () => {
            if (finished) {
                return;
            }
            finished = true;
            observer?.disconnect();
            scrollToDocumentTarget(
                document.querySelector("[data-comment-id]") ||
                    findCommentSection() ||
                    loader,
                direction
            );
        };

        observer = new MutationObserver(() => {
            if (document.querySelector("[data-comment-id]")) {
                finish();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.setTimeout(finish, 4000);
    }

    function leaveReader(direction) {
        if (!contentElement) {
            return;
        }

        const commentSection =
            direction === "next" && pageIndex === pageCount - 1
                ? findCommentSection()
                : null;
        const commentLoader =
            direction === "next" && pageIndex === pageCount - 1
                ? document.querySelector("#comment-loader")
                : null;
        let adjacentElement =
            direction === "next"
                ? contentElement.nextElementSibling
                : contentElement.previousElementSibling;
        if (!adjacentElement && contentElement.parentElement) {
            adjacentElement =
                direction === "next"
                    ? contentElement.parentElement.nextElementSibling
                    : contentElement.parentElement.previousElementSibling;
        }

        readerSuspended = true;
        deactivate();

        if (commentLoader instanceof HTMLElement) {
            commentLoader.click();
            waitForCommentsAndScroll(commentLoader, direction);
        } else {
            scrollToDocumentTarget(commentSection || adjacentElement, direction);
        }
    }

    function activate(content) {
        if (contentElement === content) {
            recalculatePages(false);
            return;
        }

        deactivate();
        addStyles();
        contentElement = content;
        applyReaderColors(contentElement);
        contentElement.classList.add(ACTIVE_CONTENT_CLASS);
        document.body.classList.add(ACTIVE_BODY_CLASS);
        hideSiteHeader();
        addChapterTitle();
        addAuthorNotes();
        createControls();
        contentElement.addEventListener("scroll", handleScroll, { passive: true });
        contentElement.addEventListener("touchstart", handleTouchStart, {
            passive: true
        });
        contentElement.addEventListener("touchend", handleTouchEnd, {
            passive: false
        });
        contentElement.addEventListener("touchcancel", handleTouchCancel, {
            passive: true
        });
        document.addEventListener("keydown", handleKeydown);
        pageIndex = 0;
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
        if (titleElement) {
            titleElement.remove();
        }
        siteHeaderElement?.classList.remove(HIDDEN_HEADER_CLASS);
        for (const authorNoteElement of authorNoteElements) {
            authorNoteElement.remove();
        }
        document.body.classList.remove(ACTIVE_BODY_CLASS);
        document.removeEventListener("keydown", handleKeydown);
        removeReaderColors();
        contentElement = null;
        controlsElement = null;
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
            readerSuspended = false;
            deactivate();
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
        return new URL(window.location.href).searchParams.has("comment");
    }

    window.addEventListener("resize", () => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
            if (isSupportedViewport()) {
                recalculatePages(false);
            } else {
                refresh();
            }
        }, 150);
    });
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