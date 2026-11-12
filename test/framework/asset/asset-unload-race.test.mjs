import { expect } from 'chai';
import { restore, spy, stub } from 'sinon';

import { Asset } from '../../../src/framework/asset/asset.js';
import { ResourceHandler } from '../../../src/framework/handlers/handler.js';
import { createApp } from '../../app.mjs';
import { jsdomSetup, jsdomTeardown } from '../../jsdom.mjs';

// A resource that behaves like a GPU-backed one: it owns something that must be released through
// destroy(), so an orphaned late load can be detected by the spy never being balanced.
class FakeGpuResource {
    constructor(name) {
        this.name = name;
        this.destroyed = false;
    }

    destroy() {
        this.destroyed = true;
    }
}

// A handler whose load completes on demand. This models a file still downloading when the scene
// switches: the test decides when (or whether) the in-flight request resolves.
class AsyncHandler extends ResourceHandler {
    constructor(app) {
        super(app, 'async');
        /** @type {Array<{resolve: Function, url: string}>} */
        this.pending = [];
    }

    load(url, callback) {
        this.pending.push({
            url: typeof url === 'string' ? url : url.load,
            callback
        });
    }

    open(url, data) {
        // a null result is the handler's cancellation signal and must pass through unchanged
        if (data === null) {
            return null;
        }
        return new FakeGpuResource(typeof url === 'string' ? url : url.original);
    }

    // resolve the oldest (or every) pending load
    resolve(all = false) {
        const pending = all ? this.pending.splice(0) : [this.pending.shift()];
        for (const request of pending) {
            request.callback(null, 'raw-data');
        }
    }

    // a handler that tracks the unload itself (like the gsplat parsers) settles a cancelled load
    // with a null resource instead of a real one
    cancelWithNull() {
        const request = this.pending.shift();
        request?.callback(null, null);
    }

    fail(err = 'network error') {
        const request = this.pending.shift();
        request?.callback(err);
    }
}

describe('asset unload while loading (load/unload race)', function () {

    let app;
    let handler;

    beforeEach(function () {
        jsdomSetup();
        app = createApp();
        handler = new AsyncHandler(app);
        app.loader.addHandler('async', handler);
    });

    afterEach(function () {
        app?.destroy();
        app = null;
        handler = null;
        jsdomTeardown();
        restore();
    });

    function createAsset(name = 'race asset', url = 'fake/race/resource.bin') {
        const asset = new Asset(name, 'async', { url });
        app.assets.add(asset);
        return asset;
    }

    it('does not resurrect an asset unloaded while its file is still downloading', function (done) {
        const asset = createAsset();
        app.assets.load(asset);

        expect(asset.loading).to.be.true;
        expect(handler.pending).to.have.lengthOf(1);

        // scene switch: unload lands in the middle of the download
        asset.unload();

        expect(asset.loading).to.be.false;
        expect(asset.loaded).to.be.false;
        expect(asset.resource).to.be.undefined;

        const onLoad = spy();
        asset.on('load', onLoad);

        // the download finishes after the unload
        handler.resolve();

        setTimeout(() => {
            // the late completion must not bring the asset back
            expect(asset.loaded, 'asset stays unloaded').to.be.false;
            expect(asset.loading, 'asset stays not loading').to.be.false;
            expect(asset.resource, 'no resource is assigned').to.be.undefined;
            expect(onLoad.called, 'no load event fires on the unloaded asset').to.be.false;
            done();
        }, 0);
    });

    it('destroys the orphaned resource a late download allocated and keeps it out of the cache', function (done) {
        const asset = createAsset();
        const fileUrl = asset.getFileUrl();
        app.assets.load(asset);
        asset.unload();

        // capture whatever open() produces when the abandoned download completes
        const resources = [];
        const originalOpen = handler.open.bind(handler);
        stub(handler, 'open').callsFake((url, data) => {
            const resource = originalOpen(url, data);
            resources.push(resource);
            return resource;
        });

        handler.resolve();

        setTimeout(() => {
            // open() ran when the download completed, but its resource has no owner: it must be
            // destroyed rather than retained in the loader cache (the leak behind the growing
            // GPU memory), and never assigned to the unloaded asset
            expect(resources).to.have.lengthOf(1);
            expect(resources[0].destroyed, 'the orphaned resource is destroyed').to.be.true;
            expect(asset.resource).to.be.undefined;
            expect(app.loader.getFromCache(fileUrl, 'async')).to.be.undefined;
            done();
        }, 0);
    });

    it('still loads normally again after being unloaded mid-download', function (done) {
        const asset = createAsset();
        app.assets.load(asset);
        asset.unload();

        // resolve the abandoned first download; nothing should surface on the asset
        handler.resolve();

        // a fresh load after the unload takes the normal path
        app.assets.load(asset);
        expect(asset.loading).to.be.true;

        asset.ready((readyAsset) => {
            expect(readyAsset).to.equal(asset);
            expect(asset.loaded).to.be.true;
            expect(asset.resource).to.be.instanceof(FakeGpuResource);
            expect(asset.resource.destroyed).to.be.false;
            done();
        });

        // the second request is a new in-flight request, resolved independently
        expect(handler.pending).to.have.lengthOf(1);
        handler.resolve();
    });

    it('keeps a shared request alive for another asset when one subscriber unloads', function (done) {
        const url = 'fake/shared/resource.bin';
        const assetA = createAsset('asset A', url);
        const assetB = createAsset('asset B', url);

        app.assets.load(assetA);
        app.assets.load(assetB);

        // the same URL/type share one underlying request with two subscribers
        expect(handler.pending).to.have.lengthOf(1);

        // only A is unloaded; B still waits on the shared download
        assetA.unload();
        expect(assetA.resource).to.be.undefined;

        assetB.ready((readyAsset) => {
            expect(readyAsset).to.equal(assetB);
            expect(assetB.resource).to.be.instanceof(FakeGpuResource);
            expect(assetB.resource.destroyed).to.be.false;
            // A is never resurrected by the shared completion
            expect(assetA.resource).to.be.undefined;
            expect(assetA.loaded).to.be.false;
            done();
        });

        handler.resolve();
    });

    it('does not fire an error event for a request whose only subscriber unloaded', function (done) {
        const asset = createAsset();
        app.assets.load(asset);
        asset.unload();

        const onError = spy();
        const onLoad = spy();
        asset.on('error', onError);
        asset.on('load', onLoad);
        const consoleError = stub(console, 'error');

        // the abandoned download fails after the unload
        handler.fail();

        setTimeout(() => {
            expect(onError.called, 'no error reaches the unloaded asset').to.be.false;
            expect(onLoad.called, 'no load reaches the unloaded asset').to.be.false;
            expect(consoleError.called, 'an ownerless failure stays silent').to.be.false;
            expect(asset.loading).to.be.false;
            expect(asset.loaded).to.be.false;
            done();
        }, 0);
    });

    it('settles a handler-driven cancellation (null resource) without resurrecting the asset', function (done) {
        const asset = createAsset();
        app.assets.load(asset);
        asset.unload();

        const onLoad = spy();
        asset.once('load', onLoad);

        // the handler tracked the unload and settles the cancelled load with null
        handler.cancelWithNull();

        setTimeout(() => {
            // the load still settles so listeners (e.g. an AssetListLoader) never hang, but it
            // carries no resource and the asset stays unloaded
            expect(onLoad.calledOnce, 'the cancellation still fires load').to.be.true;
            expect(asset.resource, 'no resource is assigned').to.be.null;
            expect(asset.loaded, 'the asset stays unloaded').to.be.false;
            expect(asset.loading).to.be.false;
            done();
        }, 0);
    });

    it('reports an error normally when the asset is still waiting for the request', function (done) {
        const asset = createAsset();
        app.assets.load(asset);

        asset.once('error', (err) => {
            expect(err).to.equal('network error');
            expect(asset.loading).to.be.false;
            expect(asset.loaded).to.be.true;
            expect(asset.resource).to.be.undefined;
            done();
        });

        handler.fail();
    });
});
