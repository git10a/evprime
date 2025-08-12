document.addEventListener('DOMContentLoaded', () => {
    // ===========================
    // 設定値の定義（マジックナンバーの排除）
    // ===========================
    const CONFIG = {
        SEARCH: {
            MIN_LENGTH: 2,           // 2文字：日本語の意味のある最小単位
            DEBOUNCE_DELAY: 150,     // 150ms：快適な入力体験の標準値
            MAX_SUGGESTIONS: 5       // 5件：UIに収まる適切な候補数
        },
        RENDERING: {
            BATCH_SIZE: 20,          // 20件：60fps維持可能な表示単位
            FRAME_DURATION: 16,      // 16ms：60fpsのフレーム間隔（1000ms/60）
            MAX_ANIMATION_DELAY: 500 // 500ms：視覚的に遅延を感じない最大値
        },
        CACHE: {
            MAX_SIZE: 50             // 50件：約200KBのメモリ使用を想定
        },
        UI: {
            SCROLL_THRESHOLD: 300,   // 300px：トップに戻るボタン表示閾値
            MODAL_FADE_DURATION: 300 // 300ms：モーダルフェード時間
        }
    };

    // ===========================
    // パフォーマンス最適化の実装
    // ===========================

    // DOM Elements
    const galleryView = document.getElementById('gallery-view');
    const searchBox = document.getElementById('search-box');
    const tagFiltersContainer = document.getElementById('tag-filters');
    const clearFiltersBtn = document.getElementById('clear-filters-btn');
    const favoritesFilterBtn = document.getElementById('favorites-filter-btn');
    const companyModalElement = document.getElementById('companyModal');
    const companyModal = new bootstrap.Modal(companyModalElement);
    const themeToggle = document.getElementById('theme-toggle');
    const clearSearchBtn = document.getElementById('clear-search');
    const searchSuggestions = document.getElementById('search-suggestions');

    // State
    let allCompanies = [];
    let allTags = new Set();
    let activeFilters = {
        tags: new Set(),
        showFavoritesOnly: false
    };
    let isLoading = false;
    let favorites = new Set();
    let currentTheme = localStorage.getItem('evPrimeTheme') || 'light';
    let popularNames = new Set();

    // ===========================
    // タイマー管理クラス（メモリリーク対策）
    // ===========================
    class TimerManager {
        constructor() {
            this.timers = new Map();
        }

        set(name, callback, delay) {
            this.clear(name);
            const id = setTimeout(() => {
                callback();
                this.timers.delete(name);
            }, delay);
            this.timers.set(name, id);
        }

        clear(name) {
            if (this.timers.has(name)) {
                clearTimeout(this.timers.get(name));
                this.timers.delete(name);
            }
        }

        clearAll() {
            this.timers.forEach(id => clearTimeout(id));
            this.timers.clear();
        }
    }

    const timerManager = new TimerManager();

    // ===========================
    // 検索インデックス（検索最適化）
    // ===========================
    const searchIndex = {
        companies: new Map(),
        tags: new Map(),

        build(companies) {
            this.companies.clear();
            this.tags.clear();

            companies.forEach(company => {
                const companyName = (company.company_name || '').toLowerCase();
                const tokens = new Set();

                // インデックス化するテキストを収集
                tokens.add(companyName);
                (company.tags || []).forEach(tag => tokens.add(tag.toLowerCase()));

                tokens.forEach(token => {
                    for (let i = CONFIG.SEARCH.MIN_LENGTH; i <= token.length; i++) {
                        const substring = token.substring(0, i);
                        if (!this.companies.has(substring)) {
                            this.companies.set(substring, new Set());
                        }
                        this.companies.get(substring).add(company);
                    }
                });
            });
        },

        search(term) {
            const lowerTerm = term.toLowerCase();
            const results = this.companies.get(lowerTerm) || new Set();
            return Array.from(results);
        }
    };

    // ===========================
    // ソート結果のキャッシュ（再計算削減）
    // ===========================
    const sortCache = {
        cache: new Map(),
        lastSortKey: null,

        getSortKey(filters) {
            return JSON.stringify({
                tags: Array.from(filters.tags),
                favorites: filters.showFavoritesOnly,
                search: searchBox.value
            });
        },

        get(companies, filters) {
            const key = this.getSortKey(filters);
            if (this.lastSortKey === key && this.cache.has(key)) {
                return this.cache.get(key);
            }
            return null;
        },

        set(companies, filters, sorted) {
            const key = this.getSortKey(filters);
            this.lastSortKey = key;
            this.cache.set(key, sorted);

            // キャッシュサイズ制限（メモリリーク防止）
            if (this.cache.size > CONFIG.CACHE.MAX_SIZE) {
                const firstKey = this.cache.keys().next().value;
                this.cache.delete(firstKey);
            }
        },

        clear() {
            this.cache.clear();
            this.lastSortKey = null;
        }
    };

    // --- Initialization ---
    initializeTheme();
    showLoadingSpinner();
    Promise.all([
        fetch('data/companies.json').then(response => response.ok ? response.json() : Promise.reject(`HTTP error! status: ${response.status}`)),
        fetch('data/popular.json').then(response => response.ok ? response.json() : [])
    ])
        .then(([companies, popular]) => {
            allCompanies = Array.isArray(companies) ? companies : [];
            popularNames = new Set((Array.isArray(popular) ? popular : [])
                .map(n => String(n).toLowerCase().trim())
                .filter(n => n.length > 0));

            // 検索インデックスを構築
            searchIndex.build(allCompanies);

            loadFavorites();
            initialize();

            // イベントデリゲーションを設定
            setupEventDelegation();
        })
        .catch(error => {
            console.error('Error fetching or parsing data:', error);
            galleryView.innerHTML = '<p class="text-danger">データの読み込みに失敗しました。</p>';
        });

    // Dark Mode Functions
    function initializeTheme() {
        document.documentElement.setAttribute('data-theme', currentTheme);
        updateThemeToggleIcon();
    }

    function toggleTheme() {
        currentTheme = currentTheme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', currentTheme);
        localStorage.setItem('evPrimeTheme', currentTheme);
        updateThemeToggleIcon();
    }

    function updateThemeToggleIcon() {
        const metaThemeColor = document.querySelector('meta[name="theme-color"]');
        if (metaThemeColor) {
            metaThemeColor.content = currentTheme === 'dark' ? '#18181b' : '#2563eb';
        }
    }

    // Theme toggle event listener
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }

    function initialize() {
        allCompanies.forEach(company => {
            if (company && company.tags && Array.isArray(company.tags)) {
                company.tags.forEach(tag => allTags.add(tag));
            }
        });
        render();
    }

    // Favorites Management
    function loadFavorites() {
        const saved = localStorage.getItem('evPrimeFavorites');
        if (saved) {
            try {
                const favArray = JSON.parse(saved);
                favorites = new Set(favArray);
            } catch (e) {
                console.error('Failed to load favorites:', e);
                favorites = new Set();
            }
        }
    }

    function saveFavorites() {
        localStorage.setItem('evPrimeFavorites', JSON.stringify([...favorites]));
    }

    function toggleFavorite(companyName, cardElement) {
        // お気に入り状態を切り替え
        const wasFavorite = favorites.has(companyName);
        if (wasFavorite) {
            favorites.delete(companyName);
        } else {
            favorites.add(companyName);
        }
        saveFavorites();

        // カード単体を更新（再レンダリングしない）
        if (cardElement) {
            updateSingleCardFavoriteState(cardElement, companyName, !wasFavorite);
        }

        // フィルターボタンのカウントのみ更新
        updateFavoritesFilterButton();

        // お気に入りフィルターがアクティブな場合のみ再描画
        if (activeFilters.showFavoritesOnly) {
            sortCache.clear(); // キャッシュをクリア
            applyFiltersAndDisplay();
        }
    }

    // 単一カードのお気に入り状態を更新
    function updateSingleCardFavoriteState(cardElement, companyName, isFavorite) {
        const favoriteBtn = cardElement.querySelector('.favorite-btn');
        const icon = favoriteBtn.querySelector('i');

        // ボタンのアイコンを更新
        icon.className = isFavorite ? 'bi bi-star-fill' : 'bi bi-star';

        // アクセシビリティ属性を更新
        favoriteBtn.title = isFavorite ? 'お気に入りから削除' : 'お気に入りに追加';
        favoriteBtn.setAttribute('aria-label', isFavorite ? 'お気に入りから削除' : 'お気に入りに追加');
    }

    // --- Main Render Function ---
    function render() {
        createTagFilterDropdown();
        updateFavoritesFilterButton();
        applyFiltersAndDisplay();
        updateTagFilterButton();
    }

    // --- Filter UI Creation ---
    function createTagFilterDropdown() {
        const sortedTags = Array.from(allTags).sort();
        const dropdownId = 'tag-dropdown-menu';

        let itemsHtml = sortedTags.map(tag => `
            <div class="dropdown-item" data-tag="${tag}">
                <input type="checkbox" id="tag-${tag}" data-tag="${tag}" ${activeFilters.tags.has(tag) ? 'checked' : ''}>
                <label for="tag-${tag}">${tag}</label>
            </div>
        `).join('');

        tagFiltersContainer.innerHTML = `
            <div class="dropdown">
                <button class="filter-btn" type="button" id="tag-filter-btn" data-bs-toggle="dropdown" aria-expanded="false">
                    <i class="bi bi-tag me-1"></i>
                    タグ ${activeFilters.tags.size > 0 ? `(${activeFilters.tags.size})` : ''}
                    <i class="bi bi-chevron-down ms-1"></i>
                </button>
                <div class="dropdown-menu" id="${dropdownId}">
                    ${itemsHtml}
                </div>
            </div>
        `;

        // Add event listener for tag selection
        document.getElementById(dropdownId).addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            let target = e.target;
            let dropdownItem = target.closest('.dropdown-item');

            if (dropdownItem) {
                const tag = dropdownItem.dataset.tag;
                const checkbox = dropdownItem.querySelector('input[type="checkbox"]');

                // Toggle checkbox
                checkbox.checked = !checkbox.checked;

                // Update filters
                if (checkbox.checked) {
                    activeFilters.tags.add(tag);
                } else {
                    activeFilters.tags.delete(tag);
                }

                sortCache.clear(); // キャッシュをクリア
                updateTagFilterButton();
                applyFiltersAndDisplay();
            }
        });
    }

    // 統合されたボタン更新関数
    function updateFilterButton(btn, isActive) {
        btn.classList.toggle('active', isActive);
    }

    function updateTagFilterButton() {
        const btn = document.getElementById('tag-filter-btn');
        if (btn) {
            const count = activeFilters.tags.size;
            btn.innerHTML = `
                <i class="bi bi-tag me-1"></i>
                タグ ${count > 0 ? `(${count})` : ''}
                <i class="bi bi-chevron-down ms-1"></i>
            `;
            updateFilterButton(btn, count > 0);
        }
    }

    function updateFavoritesFilterButton() {
        if (favoritesFilterBtn) {
            favoritesFilterBtn.innerHTML = `
                <i class="bi bi-star${activeFilters.showFavoritesOnly ? '-fill' : ''} me-1"></i>
                お気に入り
            `;
            updateFilterButton(favoritesFilterBtn, activeFilters.showFavoritesOnly);
        }
    }

    // ===========================
    // イベントデリゲーション実装（INP最適化）
    // ===========================
    function setupEventDelegation() {
        // ギャラリービューのイベントデリゲーション（パッシブリスナー）
        galleryView.addEventListener('click', handleGalleryClick, { passive: false });
        galleryView.addEventListener('keydown', handleGalleryKeydown, { passive: true });

        // 検索候補のイベントデリゲーション（パッシブリスナー）
        searchSuggestions.addEventListener('click', handleSuggestionClick, { passive: true });
    }

    function handleGalleryClick(e) {
        // 即座にユーザーフィードバックを提供（INP改善）
        const target = e.target;

        // お気に入りボタンのクリック
        const favoriteBtn = target.closest('.favorite-btn');
        if (favoriteBtn) {
            e.stopPropagation();
            e.preventDefault();

            // 即座に視覚的フィードバック
            favoriteBtn.style.transform = 'scale(0.9)';

            // 非同期で実際の処理を実行
            requestAnimationFrame(() => {
                favoriteBtn.style.transform = '';
                const card = favoriteBtn.closest('.company-card');
                if (card) {
                    const companyName = card.dataset.companyName;
                    toggleFavorite(companyName, card);
                }
            });
            return;
        }

        // カードのクリック（モーダル表示）
        const card = target.closest('.company-card');
        if (card) {
            e.preventDefault();

            // 即座に視覚的フィードバック
            card.style.opacity = '0.8';

            // 次のフレームで処理を実行（INP改善）
            requestAnimationFrame(() => {
                card.style.opacity = '';
                const companyIndex = parseInt(card.dataset.companyIndex);
                const company = allCompanies[companyIndex];
                if (company) {
                    // モーダル更新を非同期化
                    setTimeout(() => {
                        try {
                            updateModalContent(company);
                            companyModal.show();
                        } catch (error) {
                            console.error('Error showing modal:', error);
                            updateModalContent({ company_name: 'エラー', error: '企業データの表示に失敗しました。' });
                            companyModal.show();
                        }
                    }, 0);
                }
            });
        }
    }

    function handleGalleryKeydown(e) {
        const card = e.target.closest('.company-card');
        if (card && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            card.click();
        }
    }

    function handleSuggestionClick(e) {
        const item = e.target.closest('.search-suggestion-item');
        if (item) {
            searchBox.value = item.dataset.value;
            hideSearchSuggestions();
            sortCache.clear();
            applyFiltersAndDisplay();
        }
    }

    // ===========================
    // DOM操作の最適化（DocumentFragment使用 + INP改善）
    // ===========================
    function displayCompanies(companiesToDisplay) {
        // 空の状態をチェック
        if (companiesToDisplay.length === 0) {
            galleryView.innerHTML = `
                <div class="col-12">
                    <div class="empty-state">
                        <div class="empty-state-icon">🔍</div>
                        <h3>該当する企業が見つかりません</h3>
                        <p>検索条件を変更してもう一度お試しください</p>
                    </div>
                </div>
            `;
            return;
        }

        // 大量データの場合は段階的にレンダリング（INP改善）
        const totalCompanies = companiesToDisplay.length;

        if (totalCompanies > CONFIG.RENDERING.BATCH_SIZE) {
            // 最初のバッチを即座に表示
            renderBatch(companiesToDisplay.slice(0, CONFIG.RENDERING.BATCH_SIZE), 0, true);

            // 残りを非同期でレンダリング
            let currentIndex = CONFIG.RENDERING.BATCH_SIZE;

            function renderNextBatch() {
                if (currentIndex < totalCompanies) {
                    const nextBatch = companiesToDisplay.slice(currentIndex, currentIndex + CONFIG.RENDERING.BATCH_SIZE);
                    renderBatch(nextBatch, currentIndex, false);
                    currentIndex += CONFIG.RENDERING.BATCH_SIZE;

                    // 次のバッチをアイドル時にレンダリング
                    if ('requestIdleCallback' in window) {
                        requestIdleCallback(renderNextBatch, { timeout: 100 });
                    } else {
                        setTimeout(renderNextBatch, CONFIG.RENDERING.FRAME_DURATION);
                    }
                }
            }

            renderNextBatch();
        } else {
            // 少量の場合は一度にレンダリング
            renderBatch(companiesToDisplay, 0, true);
        }

        // 結果カウントをスクリーンリーダーに通知
        const displayedCount = companiesToDisplay.length;
        if (allCompanies.length > 0) {
            announceToScreenReader(`${displayedCount}件の企業が表示されています`);
        }
    }

    function renderBatch(companies, startIndex, clearFirst) {
        const fragment = document.createDocumentFragment();

        companies.forEach((company, index) => {
            if (company && typeof company === 'object') {
                const card = createCompanyCard(company, startIndex + index);
                card.classList.add('fade-in');
                // アニメーション遅延の最適化
                const delay = Math.min((startIndex + index) * 20, CONFIG.RENDERING.MAX_ANIMATION_DELAY);
                card.style.animationDelay = `${delay}ms`;
                fragment.appendChild(card);
            }
        });

        // DOMを更新
        if (clearFirst) {
            galleryView.innerHTML = '';
        }
        galleryView.appendChild(fragment);
    }

    function createCompanyCard(company, companyIndex) {
        const card = document.createElement('div');
        card.className = 'col-md-6 col-lg-4 mb-4 company-card';
        card.setAttribute('tabindex', '0');
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', `${company.company_name || '企業'}の詳細を表示`);

        // データ属性を追加（イベントデリゲーション用）
        card.dataset.companyName = company.company_name || '';
        card.dataset.companyIndex = allCompanies.indexOf(company);

        const companyName = company.company_name || '無名の企業';

        // Use actual logo if available, otherwise use placeholder
        let logoElement;
        if (company.company_logo) {
            logoElement = `<img src="${escapeHtml(company.company_logo)}" alt="${escapeHtml(companyName)}のロゴ" class="company-logo" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
            <div class="company-logo-placeholder" style="display:none;">${createLogoPlaceholderContent(companyName)}</div>`;
        } else {
            logoElement = createLogoPlaceholder(companyName);
        }

        const tagsHtml = (company.tags && Array.isArray(company.tags))
            ? company.tags.map(tag => `<span class="tag" title="${tag}">${tag}</span>`).join('')
            : '';

        const summary = getSummary(company);
        const isFavorite = favorites.has(companyName);
        const isPopular = isCompanyPopular(company);

        card.innerHTML = `
            <div class="card ${isPopular ? 'popular' : ''}">
                <button class="favorite-btn" title="${isFavorite ? 'お気に入りから削除' : 'お気に入りに追加'}" aria-label="${isFavorite ? 'お気に入りから削除' : 'お気に入りに追加'}">
                    <i class="bi bi-${isFavorite ? 'star-fill' : 'star'}"></i>
                </button>
                <div class="card-body">
                    <div class="card-header-flex">
                        <div class="logo-container">
                            ${logoElement}
                        </div>
                        <div class="card-title-wrapper">
                            <h5 class="card-title">
                                <span>${escapeHtml(companyName)}</span>
                                ${isPopular ? '<span class="popular-label">人気</span>' : ''}
                            </h5>
                        </div>
                    </div>
                    <p class="card-summary">${escapeHtml(summary)}</p>
                    <div class="tags">${tagsHtml}</div>
                </div>
            </div>
        `;

        return card;
    }


    function getSummary(company) {
        let summary = company.company_wide_plan?.summary || company.ev_prime_plan?.summary || '詳細情報はありません。';
        // Limit summary length for display
        if (summary.length > 100) {
            summary = summary.substring(0, 100) + '…';
        }
        return summary;
    }

    function createLogoPlaceholder(name) {
        const content = createLogoPlaceholderContent(name);
        const colors = ['#1abc9c', '#2ecc71', '#3498db', '#9b59b6', '#34495e', '#16a085', '#27ae60', '#2980b9', '#8e44ad', '#2c3e50', '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6', '#f39c12', '#d35400', '#c0392b', '#7f8c8d'];
        const color = colors[Math.floor(Math.abs((name.charCodeAt(0) || 0) % colors.length))];
        return `<div class="company-logo-placeholder" style="background-color: ${color};">${content}</div>`;
    }

    function createLogoPlaceholderContent(name) {
        const initial = name ? name.charAt(0).toUpperCase() : '?';
        return initial;
    }

    // Popularity check (strict): only exact match with company_name
    function isCompanyPopular(company) {
        if (!company) return false;
        const name = (company.company_name || '').toLowerCase().trim();
        return name && popularNames.has(name);
    }

    // ===========================
    // 検索処理の最適化（リファクタリング済み）
    // ===========================

    /**
     * 企業が検索条件に一致するかチェック
     * @param {Object} company - 企業データ
     * @param {string} searchTerm - 検索文字列
     * @returns {boolean} 一致する場合true
     */
    function matchesSearchTerm(company, searchTerm) {
        if (!searchTerm) return true;

        const searchableText = [
            company.company_name || '',
            company.company_wide_plan?.summary || '',
            company.ev_prime_plan?.summary || '',
            (company.tags || []).join(' '),
            company.contact_name || '',
            company.email || ''
        ].join(' ').toLowerCase();

        return searchableText.includes(searchTerm);
    }

    /**
     * 企業がタグフィルターに一致するかチェック
     * @param {Object} company - 企業データ
     * @param {Set} selectedTags - 選択されたタグ
     * @returns {boolean} 一致する場合true
     */
    function matchesTags(company, selectedTags) {
        if (selectedTags.size === 0) return true;
        if (!company.tags || !Array.isArray(company.tags)) return false;

        return [...selectedTags].every(tag => company.tags.includes(tag));
    }

    /**
     * 企業がお気に入りフィルターに一致するかチェック
     * @param {Object} company - 企業データ
     * @param {boolean} favoritesOnly - お気に入りのみ表示
     * @returns {boolean} 一致する場合true
     */
    function matchesFavorites(company, favoritesOnly) {
        if (!favoritesOnly) return true;
        return favorites.has(company.company_name || '');
    }

    /**
     * 企業データを検証
     * @param {Object} company - 企業データ
     * @returns {boolean} 有効な場合true
     */
    function isValidCompany(company) {
        return company && typeof company === 'object';
    }

    /**
     * 企業をフィルタリング
     * @param {Array} companies - 企業リスト
     * @param {Object} filters - フィルター条件
     * @param {string} searchTerm - 検索文字列
     * @returns {Array} フィルタリング済み企業リスト
     */
    function filterCompanies(companies, filters, searchTerm) {
        // 検索インデックスを使用するか判定
        if (searchTerm.length >= CONFIG.SEARCH.MIN_LENGTH) {
            // インデックスを使用した高速検索
            const indexResults = searchIndex.search(searchTerm);
            return indexResults.filter(company => {
                if (!isValidCompany(company)) return false;
                return matchesTags(company, filters.tags) &&
                    matchesFavorites(company, filters.showFavoritesOnly);
            });
        }

        // 通常のフィルタリング
        return companies.filter(company => {
            if (!isValidCompany(company)) return false;

            return matchesSearchTerm(company, searchTerm) &&
                matchesTags(company, filters.tags) &&
                matchesFavorites(company, filters.showFavoritesOnly);
        });
    }

    /**
     * 企業を人気度と名前でソート
     * @param {Array} companies - 企業リスト
     * @returns {Array} ソート済み企業リスト
     */
    function sortCompanies(companies) {
        return companies.sort((companyA, companyB) => {
            // 人気度でソート（人気のある企業を上位に）
            const popularityScoreA = isCompanyPopular(companyA) ? 1 : 0;
            const popularityScoreB = isCompanyPopular(companyB) ? 1 : 0;

            if (popularityScoreB !== popularityScoreA) {
                return popularityScoreB - popularityScoreA;
            }

            // 人気度が同じ場合は名前でソート
            const companyNameA = (companyA.company_name || '').toLowerCase();
            const companyNameB = (companyB.company_name || '').toLowerCase();

            return companyNameA.localeCompare(companyNameB);
        });
    }

    /**
     * フィルターを適用して企業を表示（メイン関数）
     */
    function applyFiltersAndDisplay() {
        const searchTerm = searchBox.value.toLowerCase().trim();

        // キャッシュをチェック
        const cached = sortCache.get(allCompanies, activeFilters);
        if (cached && searchTerm === activeFilters.lastSearchTerm) {
            requestAnimationFrame(() => {
                displayCompanies(cached);
            });
            return;
        }

        activeFilters.lastSearchTerm = searchTerm;

        // フィルタリング処理
        let filteredCompanies = filterCompanies(allCompanies, activeFilters, searchTerm);

        // ソート処理
        filteredCompanies = sortCompanies(filteredCompanies);

        // 結果をキャッシュ
        sortCache.set(allCompanies, activeFilters, filteredCompanies);

        // スムーズなレンダリングのためrequestAnimationFrameを使用
        requestAnimationFrame(() => {
            displayCompanies(filteredCompanies);
        });
    }

    // --- Enhanced Event Listeners ---
    searchBox.addEventListener('input', (e) => {
        const searchTerm = e.target.value.trim();

        // Show/hide clear button
        if (clearSearchBtn) {
            clearSearchBtn.style.display = searchTerm ? 'block' : 'none';
        }

        // Show search suggestions
        if (searchTerm.length >= CONFIG.SEARCH.MIN_LENGTH) {
            showSearchSuggestions(searchTerm);
        } else {
            hideSearchSuggestions();
        }

        // タイマー管理クラスを使用（メモリリーク防止）
        timerManager.set('search', () => {
            sortCache.clear();
            applyFiltersAndDisplay();
        }, CONFIG.SEARCH.DEBOUNCE_DELAY);
    });

    // Clear search button
    if (clearSearchBtn) {
        clearSearchBtn.addEventListener('click', () => {
            searchBox.value = '';
            clearSearchBtn.style.display = 'none';
            hideSearchSuggestions();
            sortCache.clear();
            applyFiltersAndDisplay();
            searchBox.focus();
        });
    }

    // Search suggestions functions
    function showSearchSuggestions(searchTerm) {
        const suggestions = generateSuggestions(searchTerm);

        if (suggestions.length === 0) {
            hideSearchSuggestions();
            return;
        }

        let suggestionsHtml = '';
        suggestions.forEach(suggestion => {
            suggestionsHtml += `
                <div class="search-suggestion-item" data-value="${suggestion.value}">
                    <i class="bi bi-${suggestion.icon} suggestion-icon"></i>
                    <div class="suggestion-text">
                        <div class="suggestion-title">${highlightMatch(suggestion.title, searchTerm)}</div>
                        <div class="suggestion-meta">${suggestion.meta}</div>
                    </div>
                </div>
            `;
        });

        searchSuggestions.innerHTML = suggestionsHtml;
        searchSuggestions.style.display = 'block';
    }

    function hideSearchSuggestions() {
        if (searchSuggestions) {
            searchSuggestions.style.display = 'none';
        }
    }

    function generateSuggestions(searchTerm) {
        const suggestions = [];
        const lowerSearchTerm = searchTerm.toLowerCase();

        // Company name suggestions
        const matchingCompanies = allCompanies.filter(company =>
            company.company_name && company.company_name.toLowerCase().includes(lowerSearchTerm)
        ).slice(0, CONFIG.SEARCH.MAX_SUGGESTIONS);

        matchingCompanies.forEach(company => {
            suggestions.push({
                value: company.company_name,
                title: company.company_name,
                meta: '企業名',
                icon: 'building'
            });
        });

        // Tag suggestions
        const matchingTags = Array.from(allTags).filter(tag =>
            tag.toLowerCase().includes(lowerSearchTerm)
        ).slice(0, Math.max(0, CONFIG.SEARCH.MAX_SUGGESTIONS - suggestions.length));

        matchingTags.forEach(tag => {
            suggestions.push({
                value: tag,
                title: tag,
                meta: 'タグ',
                icon: 'tag'
            });
        });

        return suggestions.slice(0, CONFIG.SEARCH.MAX_SUGGESTIONS);
    }

    function highlightMatch(text, searchTerm) {
        const regex = new RegExp(`(${searchTerm})`, 'gi');
        return text.replace(regex, '<mark>$1</mark>');
    }

    // Favorites filter button event listener
    favoritesFilterBtn.addEventListener('click', () => {
        activeFilters.showFavoritesOnly = !activeFilters.showFavoritesOnly;
        updateFavoritesFilterButton();
        sortCache.clear();
        applyFiltersAndDisplay();

        // Announce to screen reader
        const message = activeFilters.showFavoritesOnly
            ? 'お気に入りの企業のみを表示しています'
            : 'すべての企業を表示しています';
        announceToScreenReader(message);
    });

    // フィルタークリア機能を統合
    function hasActiveFilters() {
        return searchBox.value || activeFilters.tags.size > 0 || activeFilters.showFavoritesOnly;
    }

    function clearAllFilters() {
        searchBox.value = '';
        activeFilters.tags.clear();
        activeFilters.showFavoritesOnly = false;
        sortCache.clear();
        render();
    }

    clearFiltersBtn.addEventListener('click', () => {
        // Add visual feedback
        clearFiltersBtn.style.transform = 'scale(0.95)';
        timerManager.set('clearFilterAnimation', () => {
            clearFiltersBtn.style.transform = 'scale(1)';
        }, 150);

        clearAllFilters();
    });

    // Add keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        // Cmd/Ctrl + K to focus search
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
            e.preventDefault();
            searchBox.focus();
            searchBox.select();
        }

        // Escape to clear search focus or clear filters
        if (e.key === 'Escape') {
            if (document.activeElement === searchBox) {
                searchBox.blur();
            } else if (hasActiveFilters()) {
                clearAllFilters();
            }
        }
    });

    // Back to Top button implementation (パッシブリスナーでINP改善)
    const backToTopBtn = document.getElementById('back-to-top');
    let isScrolling = false;
    let lastScrollTop = 0;

    // Show/hide button based on scroll position
    window.addEventListener('scroll', () => {
        if (!isScrolling) {
            window.requestAnimationFrame(() => {
                const scrollTop = window.pageYOffset || document.documentElement.scrollTop;

                // スクロール位置に基づいて表示/非表示
                if (scrollTop > CONFIG.UI.SCROLL_THRESHOLD && scrollTop > lastScrollTop) {
                    backToTopBtn.style.display = 'block';
                    backToTopBtn.style.opacity = '1';
                } else if (scrollTop <= CONFIG.UI.SCROLL_THRESHOLD) {
                    backToTopBtn.style.opacity = '0';
                    timerManager.set('hideBackToTop', () => {
                        if (window.pageYOffset <= CONFIG.UI.SCROLL_THRESHOLD) {
                            backToTopBtn.style.display = 'none';
                        }
                    }, CONFIG.UI.MODAL_FADE_DURATION);
                }

                lastScrollTop = scrollTop;
                isScrolling = false;
            });
            isScrolling = true;
        }
    }, { passive: true }); // パッシブリスナーでINP改善

    // Scroll to top when button is clicked
    backToTopBtn.addEventListener('click', () => {
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    });

    // --- Enhanced Modal Content Update with Notion/Stripe Style ---
    function updateModalContent(company) {
        const modalBody = companyModalElement.querySelector('.modal-body');
        const modalTitleWrapper = companyModalElement.querySelector('.modal-title-wrapper');

        // Clear and rebuild modal title
        if (modalTitleWrapper) {
            modalTitleWrapper.innerHTML = '';

            // Add logo or placeholder
            const logoContainer = document.createElement('div');
            logoContainer.className = 'modal-logo-container';

            if (company.company_logo) {
                logoContainer.innerHTML = `
                    <img src="${escapeHtml(company.company_logo)}" 
                         alt="${escapeHtml(company.company_name)}のロゴ" 
                         class="modal-company-logo" 
                         onerror="this.parentElement.innerHTML='<div class=\\'modal-logo-placeholder\\'>${createLogoPlaceholderContent(company.company_name)}</div>';" />
                `;
            } else {
                // Create colored placeholder
                const initial = createLogoPlaceholderContent(company.company_name || '');
                logoContainer.innerHTML = `<div class="modal-logo-placeholder">${initial}</div>`;
            }
            modalTitleWrapper.appendChild(logoContainer);

            // Add title with subtitle
            const titleContainer = document.createElement('div');
            titleContainer.className = 'modal-title';

            const mainTitle = document.createElement('span');
            mainTitle.textContent = company.company_name || '詳細情報';
            titleContainer.appendChild(mainTitle);

            // Add subtitle if we have category information
            if (company.tags && company.tags.length > 0) {
                const subtitle = document.createElement('span');
                subtitle.className = 'modal-title-subtitle';
                subtitle.textContent = company.tags.slice(0, 2).join(' / ');
                titleContainer.appendChild(subtitle);
            }

            modalTitleWrapper.appendChild(titleContainer);
        }

        if (company.error) {
            modalBody.innerHTML = `
                <div class="alert alert-danger d-flex align-items-center" role="alert">
                    <i class="bi bi-exclamation-triangle-fill me-2"></i>
                    <div>${company.error}</div>
                </div>
            `;
            return;
        }

        let bodyHtml = '';

        if (company.company_wide_plan && (company.company_wide_plan.summary || company.company_wide_plan.features)) {
            bodyHtml += `
                <div class="mb-4">
                    <h6>全社導入可能プラン</h6>
                    <div class="bg-light">
            `;

            // summaryがある場合は表示
            if (company.company_wide_plan.summary) {
                bodyHtml += `<div>${linkify(company.company_wide_plan.summary).replace(/\n/g, '<br>')}</div>`;
            }

            // featuresがある場合は箇条書きで表示
            if (company.company_wide_plan.features && Array.isArray(company.company_wide_plan.features) && company.company_wide_plan.features.length > 0) {
                // summaryがある場合は間にスペースを追加
                if (company.company_wide_plan.summary) {
                    bodyHtml += `<div class="mt-3"></div>`;
                }

                bodyHtml += `
                    <div class="features-list">
                        <strong>特典:</strong>
                        <ul class="mt-2 mb-0">
                `;

                company.company_wide_plan.features.forEach(feature => {
                    if (feature) {
                        bodyHtml += `<li>${escapeHtml(feature)}</li>`;
                    }
                });

                bodyHtml += `
                        </ul>
                    </div>
                `;
            }

            bodyHtml += `
                    </div>
                </div>
            `;
        }
        if (company.ev_prime_plan && company.ev_prime_plan.summary) {
            bodyHtml += `
                <div class="mb-4">
                    <h6>EV Primeプラン</h6>
                    <div class="bg-light">${linkify(company.ev_prime_plan.summary).replace(/\n/g, '<br>')}</div>
                </div>
            `;
        }
        if (company.sponsorship_conditions && Array.isArray(company.sponsorship_conditions) && company.sponsorship_conditions.length > 0) {
            bodyHtml += `
                <div class="mb-4">
                    <h6>利用条件</h6>
                    <div class="bg-light">
                        <ul class="list-unstyled mb-0">
            `;
            company.sponsorship_conditions.forEach((cond, index) => {
                if (cond && cond.condition) {
                    const isLast = index === company.sponsorship_conditions.filter(c => c && c.condition).length - 1;
                    bodyHtml += `
                        <li class="${isLast ? '' : 'mb-2'}">
                            <div>
                                <span>${escapeHtml(cond.condition).replace(/\n/g, '<br>')}</span>
                                ${cond.note ? `<div class="small text-muted mt-1">${escapeHtml(cond.note).replace(/\n/g, '<br>')}</div>` : ''}
                            </div>
                        </li>
                    `;
                }
            });
            bodyHtml += '</ul></div></div>';
        }
        const contactEmail = company.contact_email || company.email;
        if (company.contact_name || contactEmail) {
            bodyHtml += `
                <div class="mb-4">
                    <h6>連絡先</h6>
                    <div class="bg-light">
            `;
            if (company.contact_name) bodyHtml += `<p class="mb-2"><strong>担当者:</strong> ${escapeHtml(company.contact_name).replace(/\n/g, '<br>')}</p>`;
            if (contactEmail) bodyHtml += `<p class="mb-0"><strong>Email:</strong> ${linkify(contactEmail)}</p>`;
            bodyHtml += '</div></div>';
        }
        if (company.application_info && company.application_info.details) {
            bodyHtml += `
                <div class="mb-4">
                    <h6>申込方法</h6>
                    <div class="bg-light">${linkify(company.application_info.details).replace(/\n/g, '<br>')}</div>
                </div>
            `;
        }
        if (company.other_references && Array.isArray(company.other_references) && company.other_references.length > 0) {
            bodyHtml += `
                <div class="mb-4">
                    <h6>その他参考情報</h6>
                    <div class="bg-light">
                        <ul class="list-unstyled mb-0">
            `;
            company.other_references.forEach((ref, index) => {
                if (ref) {
                    const isLast = index === company.other_references.filter(r => r).length - 1;
                    bodyHtml += `
                        <li class="${isLast ? '' : 'mb-2'}">
                            <span>${linkify(ref).replace(/\n/g, '<br>')}</span>
                        </li>
                    `;
                }
            });
            bodyHtml += '</ul></div></div>';
        }

        modalBody.innerHTML = bodyHtml || '<div class="text-center py-4"><p class="text-muted">詳細情報はありません。</p></div>';
    }

    function linkify(text) {
        if (!text || typeof text !== 'string') return '';
        const urlRegex = /(https?:\/\/[^\s"'<>]+)/g;
        const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/g;
        return text
            .replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" class="text-decoration-none fw-semibold">$1</a>')
            .replace(emailRegex, '<a href="mailto:$1" class="text-decoration-none fw-semibold">$1</a>');
    }

    // --- Utility Functions ---
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }


    // --- Accessibility Helpers ---
    function announceToScreenReader(message) {
        const announcement = document.createElement('div');
        announcement.setAttribute('aria-live', 'polite');
        announcement.setAttribute('aria-atomic', 'true');
        announcement.className = 'sr-only';
        announcement.textContent = message;
        document.body.appendChild(announcement);
        timerManager.set('removeAnnouncement', () => {
            if (announcement.parentNode) {
                document.body.removeChild(announcement);
            }
        }, 1000);
    }

    // Add search placeholder enhancement
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const shortcutKey = isMac ? '⌘K' : 'Ctrl+K';

    // Update the search shortcut display
    const searchShortcut = document.querySelector('.search-shortcut');
    if (searchShortcut) {
        searchShortcut.textContent = shortcutKey;
    }

    // Close suggestions when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-container')) {
            hideSearchSuggestions();
        }
    });

    // Focus search on pressing Escape in suggestions
    searchBox.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideSearchSuggestions();
            searchBox.blur();
        }
    });

    // Add loading indicator
    function showLoadingSpinner() {
        galleryView.innerHTML = `
            <div class="col-12 text-center py-5">
                <div class="spinner-border text-primary" role="status">
                    <span class="visually-hidden">読み込み中...</span>
                </div>
                <p class="mt-3 text-muted">データを読み込んでいます...</p>
            </div>
        `;
    }

    // Enhanced modal with better UX
    companyModalElement.addEventListener('shown.bs.modal', () => {
        const firstFocusable = companyModalElement.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (firstFocusable) {
            firstFocusable.focus();
        }
    });

    // ページ離脱時のクリーンアップ
    window.addEventListener('beforeunload', () => {
        timerManager.clearAll();
    });

    console.log('EV Prime 投資先共有システム初期化完了 🚀');
});

// ===========================
// フッターアニメーション関数
// ===========================
function animateHeart(element) {
    // ハートアニメーション
    element.style.transform = 'scale(1.5) rotate(15deg)';
    const svg = element.querySelector('svg');
    svg.style.fill = '#ff1744';

    setTimeout(() => {
        element.style.transform = 'scale(1) rotate(0deg)';
        svg.style.fill = '';
    }, 300);

    // パーティクルエフェクトを生成
    createHeartParticles(element);
}

// ハートクリック時のパーティクルエフェクト
function createHeartParticles(element) {
    const rect = element.getBoundingClientRect();
    const particles = 6;

    for (let i = 0; i < particles; i++) {
        const particle = document.createElement('div');
        particle.style.position = 'fixed';
        particle.style.left = rect.left + rect.width / 2 + 'px';
        particle.style.top = rect.top + rect.height / 2 + 'px';
        particle.style.width = '8px';
        particle.style.height = '8px';
        particle.style.background = '#ff006e';
        particle.style.borderRadius = '50%';
        particle.style.pointerEvents = 'none';
        particle.style.zIndex = '9999';

        document.body.appendChild(particle);

        const angle = (360 / particles) * i;
        const distance = 50;
        const x = Math.cos(angle * Math.PI / 180) * distance;
        const y = Math.sin(angle * Math.PI / 180) * distance;

        particle.animate([
            {
                transform: 'translate(-50%, -50%) scale(1)',
                opacity: 1
            },
            {
                transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(0)`,
                opacity: 0
            }
        ], {
            duration: 600,
            easing: 'ease-out'
        });

        setTimeout(() => particle.remove(), 600);
    }
}

