import { Debug } from '../../core/debug.js';
import { http } from '../../platform/net/http.js';

/**
 * @import { AppBase } from '../app-base.js'
 * @import { AssetRegistry } from '../asset/asset-registry.js'
 * @import { Asset } from '../asset/asset.js'
 * @import { AssetType } from '../asset/asset.js'
 * @import { BundlesFilterCallback } from '../asset/asset-registry.js'
 * @import { ResourceHandler } from './handler.js'
 */

/**
 * @callback ResourceLoaderCallback
 * Callback used by {@link ResourceLoader#load} when a resource is loaded (or an error occurs).
 * @param {string|null} err - The error message in the case where the load fails.
 * @param {any} [resource] - The resource that has been successfully loaded.
 * @returns {void}
 */

/**
 * A single in-flight {@link ResourceLoader#load} request and everything waiting on it. The same
 * URL and type share one request, so an entry can hold several (callback, asset) subscribers. An
 * asset unloaded mid-download marks its subscribers inactive rather than deleting them: this keeps
 * the callbacks reachable for a handler's cancellation signal (a null resource that must still
 * settle the load), while letting a real late result recognise that nobody owns it anymore.
 *
 * @ignore
 */
class PendingRequest {
    /**
     * @type {ResourceLoaderCallback[]}
     */
    callbacks = [];

    /**
     * The asset each callback at the same index was registered for. A null entry marks a
     * subscriber that supplied no asset (a direct ResourceLoader#load call), which can never
     * unsubscribe and therefore always stays active.
     *
     * @type {(Asset|null)[]}
     */
    assets = [];

    /**
     * Whether the callback at the same index still waits on the request. Entries belonging to an
     * asset that unloaded mid-download are flipped to false but retained.
     *
     * @type {boolean[]}
     */
    active = [];

    /**
     * @param {ResourceLoaderCallback} callback - The callback waiting on the request.
     * @param {Asset} [asset] - The asset that initiated the request, if any.
     */
    add(callback, asset) {
        this.callbacks.push(callback);
        this.assets.push(asset ?? null);
        this.active.push(true);
    }

    /**
     * Deactivate every subscriber registered for the given asset. Its callback is retained so a
     * null cancellation result can still reach it, but it no longer counts as an owner of a real
     * result.
     *
     * @param {Asset} asset - The asset that unsubscribed.
     */
    remove(asset) {
        for (let i = 0; i < this.assets.length; i++) {
            if (this.assets[i] === asset) {
                this.active[i] = false;
            }
        }
    }

    /**
     * Whether any active subscriber still waits on this request. Subscribers without an asset
     * cannot be removed, so they always count.
     *
     * @returns {boolean} True if at least one active subscriber remains.
     */
    hasSubscribers() {
        return this.active.some(entry => entry);
    }
}

/**
 * The ResourceLoader turns a URL and an asset type into a loaded resource. It owns one
 * {@link ResourceHandler} per type, dispatches each request to the matching handler, and caches the
 * result by URL and type so the same request is fetched once. Each application has one at
 * {@link AppBase#loader}.
 *
 * Most code never calls the loader directly: the {@link AssetRegistry} does so on its behalf when
 * an {@link Asset} loads. Use the loader to add support for a new asset type with
 * {@link addHandler}, to reach an existing handler with {@link getHandler}, or to tune requests
 * with {@link maxConcurrentRequests}, {@link withCredentials} and {@link enableRetry}.
 *
 * Parsers for formats the engine does not load by default ship in the package and are registered on
 * an existing handler rather than added as one: `playcanvas/scripts/esm/parsers/obj-model.mjs` adds
 * `.obj` model loading and `playcanvas/scripts/esm/parsers/spz-parser.mjs` adds `.spz`
 * Gaussian-splat loading.
 *
 * @example
 * app.loader.getHandler('model').addParser(new ObjModelParser(app.graphicsDevice));
 * @example
 * app.loader.getHandler('gsplat').addParser(new SpzParser(app));
 * @category Asset
 */
class ResourceLoader {
    /**
     * Create a new ResourceLoader instance.
     *
     * @param {AppBase} app - The application.
     */
    constructor(app) {
        this._handlers = {};
        // each in-flight request is an entry holding the callbacks waiting on it and the assets
        // that initiated them, so an asset unloaded mid-download can unsubscribe and leave a late
        // result without a live owner un-cached and destroyed
        this._requests = {};
        this._cache = {};
        this._app = app;
    }

    /**
     * Add a {@link ResourceHandler} for a resource type. Handler should support at least `load()`
     * and `open()`. Handlers can optionally support patch(asset, assets) to handle dependencies on
     * other assets.
     *
     * @param {AssetType | (string & {})} type - The name of the resource type that the handler will
     * be registered with: one of the built-in {@link AssetType} names, such as `'texture'`, `'model'`
     * or `'container'`, or a new name for an application-defined handler. See {@link AssetMap} for
     * typing the resource of a new name.
     * @param {ResourceHandler} handler - An instance of a resource handler
     * supporting at least `load()` and `open()`.
     * @example
     * // register a handler for a new 'csv' asset type (see ResourceHandler for the class)
     * app.loader.addHandler('csv', new CsvHandler(app));
     */
    addHandler(type, handler) {
        this._handlers[type] = handler;
        handler._loader = this;
    }

    /**
     * Remove a {@link ResourceHandler} for a resource type.
     *
     * @param {AssetType | (string & {})} type - The name of the type that the handler will be removed.
     */
    removeHandler(type) {
        delete this._handlers[type];
    }

    /**
     * Get a {@link ResourceHandler} for a resource type.
     *
     * @param {AssetType | (string & {})} type - The name of the resource type that the handler is
     * registered with.
     * @returns {ResourceHandler|undefined} The registered handler, or
     * undefined if the requested handler is not registered.
     */
    getHandler(type) {
        return this._handlers[type];
    }

    static makeKey(url, type) {
        return `${url}-${type}`;
    }

    /**
     * Make a request for a resource from a remote URL. Parse the returned data using the handler
     * for the specified type. When loaded and parsed, use the callback to return an instance of
     * the resource.
     *
     * @param {string|null} url - The URL of the resource to load. Can be null for an asset that is
     * not loaded from a file of its own, such as a cubemap loaded from its face assets.
     * @param {string} type - The type of resource expected.
     * @param {ResourceLoaderCallback} callback - The callback used when the resource is loaded or
     * an error occurs. Passed (err, resource) where err is null if there are no errors.
     * @param {Asset} [asset] - Optional asset that is passed into
     * handler.
     * @param {object} [options] - Additional options for loading.
     * @param {boolean} [options.bundlesIgnore] - If set to true, then asset will not try to load
     * from a bundle. Defaults to false.
     * @param {BundlesFilterCallback} [options.bundlesFilter] - A callback that will be called
     * when loading an asset that is contained in any of the bundles. It provides an array of
     * bundles and will ensure asset is loaded from bundle returned from a callback. By default,
     * the smallest filesize bundle is chosen.
     * @example
     * app.loader.load("../path/to/texture.png", "texture", function (err, texture) {
     *     // use texture here
     * });
     */
    load(url, type, callback, asset, options) {
        const handler = this._handlers[type];
        if (!handler) {
            const err = `No resource handler for asset type: '${type}' when loading [${url}]`;
            Debug.errorOnce(err);
            callback(err);
            return;
        }

        // handle requests with null file
        if (!url) {
            this._loadNull(handler, callback, asset);
            return;
        }

        const key = ResourceLoader.makeKey(url, type);

        if (this._cache[key] !== undefined) {
            // in cache
            callback(null, this._cache[key]);
        } else if (this._requests[key]) {
            // existing request
            this._requests[key].add(callback, asset);
        } else {
            // new request
            const entry = new PendingRequest();
            entry.add(callback, asset);
            this._requests[key] = entry;

            const self = this;

            const handleLoad = function (err, urlObj) {
                if (err) {
                    self._onFailure(key, err);
                    return;
                }

                if (urlObj.load instanceof DataView) {
                    if (handler.openBinary) {
                        const request = self._requests[key];
                        if (!request) {
                            return;
                        }

                        try {
                            const data = handler.openBinary(urlObj.load);
                            // the download outlived every active subscriber: keep its result out of
                            // the cache so it cannot be handed out as an ownerless resource later
                            if (!request.hasSubscribers()) {
                                delete self._requests[key];
                                data?.destroy?.();
                                return;
                            }
                            self._onSuccess(key, data);
                        } catch (err) {
                            self._onFailure(key, err);
                        }
                        return;
                    }

                    urlObj.load = URL.createObjectURL(new Blob([urlObj.load]));
                    if (asset) {
                        if (asset.urlObject) {
                            URL.revokeObjectURL(asset.urlObject);
                        }
                        asset.urlObject = urlObj.load;
                    }
                }

                handler.load(urlObj, (err, data, extra) => {
                    // make sure key exists because loader
                    // might have been destroyed by now
                    const request = self._requests[key];
                    if (!request) {
                        return;
                    }

                    if (err) {
                        self._onFailure(key, err);
                        return;
                    }

                    let resource;
                    try {
                        resource = handler.open(urlObj.original, data, asset);
                    } catch (e) {
                        self._onFailure(key, e);
                        return;
                    }

                    if (!request.hasSubscribers()) {
                        // every asset waiting on this request was unloaded before it finished. A null
                        // resource is the handler's cancellation signal (it tracked the unload and
                        // settled the load itself): deliver it to the retained callbacks so the
                        // unloaded asset's listeners resolve rather than hanging. Anything else is an
                        // orphaned late result allocated after the unload with no owner, so keep it out
                        // of the cache and release it (the GPU memory leak behind assets resurrecting
                        // on a late download).
                        if (resource === null) {
                            const { callbacks } = request;
                            delete self._requests[key];
                            for (let i = 0; i < callbacks.length; i++) {
                                callbacks[i](null, null, extra);
                            }
                            return;
                        }

                        delete self._requests[key];
                        resource?.destroy?.();
                        if (urlObj.load && urlObj.load.startsWith('blob:') && asset?.urlObject === urlObj.load) {
                            URL.revokeObjectURL(urlObj.load);
                            asset.urlObject = null;
                        }
                        return;
                    }

                    self._onSuccess(key, resource, extra);
                }, asset);
            };

            const normalizedUrl = url.split('?')[0];
            if (this._app.enableBundles && this._app.bundles.hasUrl(normalizedUrl) && !(options && options.bundlesIgnore)) {
                // if there is no loaded bundle with asset, then start loading a bundle
                if (!this._app.bundles.urlIsLoadedOrLoading(normalizedUrl)) {
                    const bundles = this._app.bundles.listBundlesForAsset(asset);
                    let bundle;

                    if (options && options.bundlesFilter) {
                        bundle = options.bundlesFilter(bundles);
                    }

                    if (!bundle) {
                        // prioritize smallest bundle
                        bundles?.sort((a, b) => {
                            return a.file.size - b.file.size;
                        });
                        bundle = bundles?.[0];
                    }

                    if (bundle) this._app.assets?.load(bundle);
                }

                this._app.bundles.loadUrl(normalizedUrl, (err, fileUrlFromBundle) => {
                    handleLoad(err, {
                        load: fileUrlFromBundle,
                        original: normalizedUrl
                    });
                });
            } else {
                handleLoad(null, {
                    load: url,
                    original: asset && asset.file.filename || url
                });
            }
        }
    }

    // load an asset with no url, skipping bundles and caching
    _loadNull(handler, callback, asset) {
        const onLoad = function (err, data, extra) {
            if (err) {
                callback(err);
            } else {
                try {
                    callback(null, handler.open(null, data, asset), extra);
                } catch (e) {
                    callback(e);
                }
            }
        };
        handler.load(null, onLoad, asset);
    }

    _onSuccess(key, result, extra) {
        const request = this._requests[key];
        if (!request) {
            return;
        }

        if (result !== null) {
            this._cache[key] = result;
        } else {
            delete this._cache[key];
        }

        const { callbacks, active } = request;
        delete this._requests[key];
        // only active subscribers receive a real result; inactive ones unloaded and must not be
        // resurrected by a late completion
        for (let i = 0; i < callbacks.length; i++) {
            if (active[i]) {
                callbacks[i](null, result, extra);
            }
        }
    }

    _onFailure(key, err) {
        const request = this._requests[key];
        if (!request) {
            return;
        }

        const { callbacks, active } = request;
        const hasActive = active.some(entry => entry);

        // a request whose every subscriber unloaded fails into nothing: stay quiet rather than
        // reporting an error nobody handles
        if (hasActive) {
            // include a string-form message so external error reporters (which often JSON.stringify the
            // arguments) get useful context, while keeping the original Error available for dev tools
            console.error(`Failed to load resource [${key}]: ${err?.message ?? err}`, err);
        }

        delete this._requests[key];
        for (let i = 0; i < callbacks.length; i++) {
            if (active[i]) {
                callbacks[i](err);
            }
        }
    }

    /**
     * Convert raw resource data into a resource instance. E.g. Take 3D model format JSON and
     * return a {@link Model}.
     *
     * @param {string} type - The type of resource.
     * @param {*} data - The raw resource data.
     * @returns {*} The parsed resource data.
     */
    open(type, data) {
        const handler = this._handlers[type];
        if (!handler) {
            console.warn(`No resource handler found for: ${type}`);
            return data;
        }

        return handler.open(null, data);

    }

    /**
     * Perform any operations on a resource, that requires a dependency on its asset data or any
     * other asset data.
     *
     * @param {Asset} asset - The asset to patch.
     * @param {AssetRegistry} assets - The asset registry.
     */
    patch(asset, assets) {
        const handler = this._handlers[asset.type];
        if (!handler)  {
            console.warn(`No resource handler found for: ${asset.type}`);
            return;
        }

        if (handler.patch) {
            handler.patch(asset, assets);
        }
    }

    /**
     * Remove resource from cache.
     *
     * @param {string} url - The URL of the resource.
     * @param {string} type - The type of resource.
     */
    clearCache(url, type) {
        const key = ResourceLoader.makeKey(url, type);
        delete this._cache[key];
    }

    /**
     * Unsubscribe an asset from an in-flight request. Called when the asset is unloaded while its
     * file is still downloading: the download itself cannot be cancelled at the HTTP layer, but the
     * request stops delivering its result to this asset, and once it has no subscribers left its
     * late result is discarded and destroyed instead of being cached behind an owner that no longer
     * exists. Has no effect when the request has already completed or was never started.
     *
     * @param {string} url - The URL of the resource the asset was loading.
     * @param {string} type - The type of resource.
     * @param {Asset} asset - The asset that no longer waits for the request.
     * @ignore
     */
    unsubscribe(url, type, asset) {
        const key = ResourceLoader.makeKey(url, type);
        this._requests[key]?.remove(asset);
    }

    /**
     * Check cache for resource from a URL. If present, return the cached value.
     *
     * @param {string} url - The URL of the resource to get from the cache.
     * @param {string} type - The type of the resource.
     * @returns {*} The resource loaded from the cache.
     */
    getFromCache(url, type) {
        const key = ResourceLoader.makeKey(url, type);
        if (this._cache[key]) {
            return this._cache[key];
        }
        return undefined;
    }

    /**
     * Enables retrying of failed requests when loading assets. Retries use exponential backoff and
     * are also enabled by default for new applications.
     *
     * @param {number} [maxRetries] - The maximum number of times to retry loading an asset.
     * Defaults to 5.
     */
    enableRetry(maxRetries = 5) {
        maxRetries = Math.max(0, Math.floor(maxRetries)) || 0;

        for (const key in this._handlers) {
            this._handlers[key].maxRetries = maxRetries;
        }
    }

    /**
     * Disables retrying of failed requests when loading assets.
     */
    disableRetry() {
        for (const key in this._handlers) {
            this._handlers[key].maxRetries = 0;
        }
    }

    /**
     * Sets the maximum number of asset requests that can be in flight at the same time. Additional
     * requests are queued and dispatched as earlier ones complete. This prevents browsers from
     * rejecting requests with `net::ERR_INSUFFICIENT_RESOURCES` when an app loads a very large
     * number of assets at once. Set to `0` to disable throttling. Defaults to 128.
     *
     * Note: this is a process-global limit (it applies to the shared HTTP layer, matching the
     * browser's per-process resource limit), so with multiple applications the last value set wins.
     * It applies to all XHR-based requests, which covers the large majority of asset loads.
     *
     * @type {number}
     * @example
     * // never have more than 50 asset requests in flight at once
     * app.loader.maxConcurrentRequests = 50;
     */
    set maxConcurrentRequests(value) {
        // clamp to a non-negative integer (Infinity is preserved and also means "unlimited")
        http.maxConcurrentRequests = Math.max(0, Math.floor(value)) || 0;
    }

    /**
     * Gets the maximum number of asset requests that can be in flight at the same time.
     *
     * @type {number}
     */
    get maxConcurrentRequests() {
        return http.maxConcurrentRequests;
    }

    /**
     * Sets whether asset requests are sent with credentials. When true, cross-origin requests
     * include credentials (cookies, client TLS certificates and HTTP authentication), allowing
     * assets to be loaded from an authenticated cross-origin host. The server must respond with a
     * non-wildcard `Access-Control-Allow-Origin` and `Access-Control-Allow-Credentials: true`.
     * Defaults to false.
     *
     * Set this before assets start loading (i.e. before {@link AppBase#preload} or
     * {@link AssetRegistry#load}). Note this is a process-global setting (it applies to the shared
     * HTTP layer), so with multiple applications the last value set wins. It covers every asset
     * load, including the asset bundle and gaussian splat loaders that fetch their data directly
     * rather than through the HTTP layer.
     *
     * @type {boolean}
     * @example
     * // load all assets from an authenticated cross-origin host
     * app.loader.withCredentials = true;
     */
    set withCredentials(value) {
        http.withCredentials = !!value;
    }

    /**
     * Gets whether asset requests are sent with credentials.
     *
     * @type {boolean}
     */
    get withCredentials() {
        return http.withCredentials;
    }

    /**
     * Destroys the resource loader.
     */
    destroy() {
        this._handlers = {};
        this._requests = {};
        this._cache = {};
        this._app = null;
    }
}

export { ResourceLoader };
