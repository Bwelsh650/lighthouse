/**
 * @license Copyright 2020 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @fileoverview Audit which identifies third-party code on the page which can be lazy loaded.
 * The audit will recommend a facade alternative which is used to imitate the third party resource until it is needed.
 *
 * Entity: Set of domains which are used by a company or product area to deliver third party resources
 * Product: Specific piece of software belonging to an entity. Entities can have multiple products.
 * Facade: Placeholder for a product which looks likes the actual product and replaces itself with that product when the user needs it.
 */

const Audit = require('./audit.js');
const i18n = require('../lib/i18n/i18n.js');
const thirdPartyWeb = require('../lib/third-party-web.js');
const NetworkRecords = require('../computed/network-records.js');
const MainResource = require('../computed/main-resource.js');
const MainThreadTasks = require('../computed/main-thread-tasks.js');
const ThirdPartySummary = require('./third-party-summary.js');

const UIStrings = {
  /** Title of a diagnostic audit that provides details about the third-party code on a web page that can be lazy loaded with a facade alternative. This descriptive title is shown to users when no resources have facade alternatives available. Lazy loading means loading resources is deferred until they are needed. */
  title: 'Lazy load third-party resources with facades',
  /** Title of a diagnostic audit that provides details about the third-party code on a web page that can be lazy loaded with a facade alternative. This descriptive title is shown to users when one or more third-party resources have available facade alternatives. Lazy loading means loading resources is deferred until they are needed. */
  failureTitle: 'Some third-party resources can be lazy loaded with a facade',
  /** Description of a Lighthouse audit that identifies the third party code on the page that can be lazy loaded with a facade alternative. This is displayed after a user expands the section to see more. No character length limits. 'Learn More' becomes link text to additional documentation. Lazy loading means loading resources is deferred until they are needed. */
  description: 'Some third party embeds can be lazy loaded. ' +
    'Consider replacing them with a facade until they are required. [Learn more](https://web.dev/efficiently-load-third-party-javascript/).',
  /** Summary text for the result of a Lighthouse audit that identifies the third party code on a web page that can be lazy loaded with a facade alternative. This text summarizes the number of lazy loading facades that can be used on the page. Lazy loading means loading resources is deferred until they are needed. */
  displayValue: `{itemCount, plural,
  =1 {# facade alternative available}
  other {# facade alternatives available}
  }`,
  /** Label for a table column that displays the name of the product that a URL is used for. A product is a piece of software used on the page. */
  columnProduct: 'Product',
  /**
   * @description Template for a table entry that gives the name of a product which we categorize as video related.
   * @example {YouTube Embedded Player} productName
   */
  categoryVideo: '{productName} (Video)',
  /**
   * @description Template for a table entry that gives the name of a product which we categorize as customer success related. Customer success means the product supports customers by offering chat and contact solutions.
   * @example {Intercom Widget} productName
   */
  categoryCustomerSuccess: '{productName} (Customer Success)',
  /**
   * @description Template for a table entry that gives the name of a product which we categorize as marketing related.
   * @example {Drift Live Chat} productName
   */
  categoryMarketing: '{productName} (Marketing)',
  /**
   * @description Template for a table entry that gives the name of a product which we categorize as social related.
   * @example {Facebook Messenger Customer Chat} productName
   */
  categorySocial: '{productName} (Social)',
};

const str_ = i18n.createMessageInstanceIdFn(__filename, UIStrings);

/** @type {Record<string, string>} */
const CATEGORY_UI_MAP = {
  'video': UIStrings.categoryVideo,
  'customer-success': UIStrings.categoryCustomerSuccess,
  'marketing': UIStrings.categoryMarketing,
  'social': UIStrings.categorySocial,
};

/** @type {Record<string, RegExp>} */
const DEFERRABLE_PRODUCT_FIRST_RESOURCE = {
  'Facebook Messenger Customer Chat': /connect\.facebook.net\/.*\/sdk\/xfbml\.customerchat\.js/,
  'YouTube Embedded Player': /youtube\.com\/embed\//,
  'Help Scout Beacon': /beacon-v2\.helpscout\.net/,
  'Vimeo Embedded Player': /player\.vimeo\.com\/video\//,
  'Drift Live Chat': /js\.driftt\.com\/include\/.*\/.*\.js/,
  'Intercom Widget': /widget\.intercom\.io\/widget\/.*/,
};

/** @typedef {import("third-party-web").IEntity} ThirdPartyEntity */
/** @typedef {import("third-party-web").IProduct} ThirdPartyProduct*/
/** @typedef {import("third-party-web").IFacade} ThirdPartyFacade*/

/** @typedef {{
 *  product: ThirdPartyProduct,
 *  startOfProductRequests: number,
 *  transferSize: number,
 *  blockingTime: number,
 *  urlSummaries: Map<string, ThirdPartySummary.Summary>
 * }} FacadableProductSummary
 */

class ThirdPartyFacades extends Audit {
  /**
   * @return {LH.Audit.Meta}
   */
  static get meta() {
    return {
      id: 'third-party-facades',
      title: str_(UIStrings.title),
      failureTitle: str_(UIStrings.failureTitle),
      description: str_(UIStrings.description),
      requiredArtifacts: ['traces', 'devtoolsLogs', 'URL'],
    };
  }

  /**
   * @param {string} url
   * @return {string[]}
   */
  static firstResourceProductNames(url) {
    const productNames = [];
    for (const [name, regex] of Object.entries(DEFERRABLE_PRODUCT_FIRST_RESOURCE)) {
      if (regex.test(url)) productNames.push(name);
    }
    return productNames;
  }

  /**
   * @param {(ThirdPartySummary.Summary & {url: string | LH.IcuMessage})[]} items
   */
  static condenseItems(items) {
    const splitIndex = items.findIndex((item) => item.transferSize < 1000);
    if (splitIndex === -1) return;

    const remainder = items.splice(splitIndex);
    const finalItem = remainder.reduce((result, item) => {
      result.transferSize += item.transferSize;
      result.blockingTime += item.blockingTime;
      result.mainThreadTime += item.mainThreadTime;
      return result;
    });
    finalItem.url = str_(i18n.UIStrings.otherValue);
    finalItem.firstStartTime = finalItem.firstContentAvailable = 0;
    items.push(finalItem);
  }

  /**
   * @param {Map<string, ThirdPartySummary.Summary>} byURL
   * @param {ThirdPartyEntity | undefined} mainEntity
   * @return {FacadableProductSummary[]}
   */
  static getFacadableProductSummaries(byURL, mainEntity) {
    /** @type {Map<string, Map<string, FacadableProductSummary>>} */
    const entitySummaries = new Map();

    // The first pass finds all requests to products that have a facade.
    for (const url of byURL.keys()) {
      const entity = thirdPartyWeb.getEntity(url);
      if (!entity || thirdPartyWeb.isFirstParty(url, mainEntity)) continue;

      const product = thirdPartyWeb.getProduct(url);
      if (!product || !product.facades || !product.facades.length) continue;

      /** @type {Map<string, FacadableProductSummary>} */
      const productSummaries = entitySummaries.get(entity.name) || new Map();
      if (productSummaries.has(product.name)) continue;

      productSummaries.set(product.name, {
        product,
        transferSize: 0,
        blockingTime: 0,
        startOfProductRequests: Infinity,
        urlSummaries: new Map(),
      });
      entitySummaries.set(entity.name, productSummaries);
    }

    // The second pass finds the first request for any products found in the first pass.
    for (const [url, urlSummary] of byURL) {
      const entity = thirdPartyWeb.getEntity(url);
      if (!entity || thirdPartyWeb.isFirstParty(url, mainEntity)) continue;

      const productSummaries = entitySummaries.get(entity.name);
      if (!productSummaries) continue;

      const productNames = this.firstResourceProductNames(url);
      if (!productNames.length) continue;

      for (const productName of productNames) {
        const productSummary = productSummaries.get(productName);
        if (!productSummary) continue;

        productSummary.urlSummaries.set(url, urlSummary);
        productSummary.transferSize += urlSummary.transferSize;
        productSummary.blockingTime += urlSummary.blockingTime;

        // This is the time the product resource is fetched.
        // Any resources of the same entity fetched after this point are considered as part of this product.
        productSummary.startOfProductRequests
          = Math.min(productSummary.startOfProductRequests, urlSummary.firstContentAvailable);

        productSummaries.set(productName, productSummary);
      }
      entitySummaries.set(entity.name, productSummaries);
    }

    // The third pass finds all other resources belonging to one of the products found above.
    for (const [url, urlSummary] of byURL) {
      const entity = thirdPartyWeb.getEntity(url);
      if (!entity || thirdPartyWeb.isFirstParty(url, mainEntity)) continue;

      // The first resource was already counted.
      if (this.firstResourceProductNames(url).length) continue;

      const productSummaries = entitySummaries.get(entity.name);
      if (!productSummaries) continue;

      // If the url does not have a facade but one or more products on its entity do,
      // we still want to record this url because it was probably fetched by a product with a facade.
      for (const productSummary of productSummaries.values()) {
        if (urlSummary.firstStartTime < productSummary.startOfProductRequests) continue;
        productSummary.urlSummaries.set(url, urlSummary);
        productSummary.transferSize += urlSummary.transferSize;
        productSummary.blockingTime += urlSummary.blockingTime;
      }

      entitySummaries.set(entity.name, productSummaries);
    }

    const allProductSummaries = [];
    for (const productSummaries of entitySummaries.values()) {
      for (const productSummary of productSummaries.values()) {
        // Ignore any product where a first request could not be found.
        if (productSummary.startOfProductRequests === Infinity) continue;
        allProductSummaries.push(productSummary);
      }
    }
    return allProductSummaries;
  }

  /**
   * @param {LH.Artifacts} artifacts
   * @param {LH.Audit.Context} context
   * @return {Promise<LH.Audit.Product>}
   */
  static async audit(artifacts, context) {
    const settings = context.settings;
    const trace = artifacts.traces[Audit.DEFAULT_PASS];
    const devtoolsLog = artifacts.devtoolsLogs[Audit.DEFAULT_PASS];
    const networkRecords = await NetworkRecords.request(devtoolsLog, context);
    const mainResource = await MainResource.request({devtoolsLog, URL: artifacts.URL}, context);
    const mainEntity = thirdPartyWeb.getEntity(mainResource.url);
    const tasks = await MainThreadTasks.request(trace, context);
    const multiplier = settings.throttlingMethod === 'simulate' ?
      settings.throttling.cpuSlowdownMultiplier : 1;
    const thirdPartySummaries = ThirdPartySummary.getSummaries(networkRecords, tasks, multiplier);
    const productSummaries
      = ThirdPartyFacades.getFacadableProductSummaries(thirdPartySummaries.byURL, mainEntity);

    /** @type {LH.Audit.Details.TableItem[]} */
    const results = [];
    for (const productSummary of productSummaries) {
      const product = productSummary.product;
      const categoryTemplate = CATEGORY_UI_MAP[product.categories[0]];

      let productWithCategory;
      if (categoryTemplate) {
        // Display product name with category next to it in the same column
        productWithCategory = str_(categoryTemplate, {productName: product.name});
      } else {
        // Just display product name if no category is found
        productWithCategory = product.name;
      }

      const items = Array.from(productSummary.urlSummaries)
        .map(([url, urlStats]) => {
          return {url, ...urlStats};
        })
        .sort((a, b) => b.transferSize - a.transferSize);
      this.condenseItems(items);
      results.push({
        product: productWithCategory,
        transferSize: productSummary.transferSize,
        blockingTime: productSummary.blockingTime,
        subItems: {type: 'subitems', items},
      });
    }

    if (!results.length) {
      return {
        score: 1,
        notApplicable: true,
      };
    }

    /** @type {LH.Audit.Details.Table['headings']} */
    const headings = [
      /* eslint-disable max-len */
      {key: 'product', itemType: 'text', subItemsHeading: {key: 'url', itemType: 'url'}, text: str_(UIStrings.columnProduct)},
      {key: 'transferSize', granularity: 1, itemType: 'bytes', subItemsHeading: {key: 'transferSize'}, text: str_(i18n.UIStrings.columnTransferSize)},
      {key: 'blockingTime', granularity: 1, itemType: 'ms', subItemsHeading: {key: 'blockingTime'}, text: str_(i18n.UIStrings.columnBlockingTime)},
      /* eslint-enable max-len */
    ];

    return {
      score: 0,
      displayValue: str_(UIStrings.displayValue, {
        itemCount: results.length,
      }),
      details: Audit.makeTableDetails(headings, results),
    };
  }
}

module.exports = ThirdPartyFacades;
module.exports.UIStrings = UIStrings;
