import 'zone.js/plugins/zone'; //Zone JS is required by default for Angular itself.
/**************************************************************
 Author:          DI Robert Grüneis/HTL Grieskirchen
 Version:         2.2.1
 Date:            2024-11-16
 Angular version: 18
 **************************************************************
 * Note! Dont' forget to add the following:
 * - Add "src/linq.polyfill.ts" to "files" in tsconfig.app.json (ca. line 8):   
 *     --> "files": [ "src/main.ts", "src/linq.polyfill.ts" ]
 * - Add "src/linq.polyfill.ts" to architect-->build-->options-->polyfills in angular.json (ca. line 49)):
 *     --> "polyfills": [ "zone.js", "src/linq.polyfill.ts" ]
 **************************************************************/
console.log('using linq.polyfill v2.2.1 [2024-11-16]');
/***************************************************************************************************
 * Array function prototypes
 ***************************************************************************************************/
declare global {
  interface Array<T> {
    any: (fct?: (element: T) => any) => boolean;
    average: (fct?: (element: T) => number) => number;
    count: () => number;
    distinct: () => T[];
    distinctBy: (fct: (element: T) => number | string) => T[];
    first: (fct?: (element: T) => any) => T;
    firstOrDefault: (fct?: (element: T) => any) => T | null;
    groupBy: (keySelector: (element: T) => any, valueSelector?: (element: T) => any) => any;
    last: (fct?: (element: T) => any) => T;
    max: (fct?: (element: T) => number) => number;
    median: () => T;
    min: (fct?: (element: T) => number) => number;
    order: () => T[];
    orderDescending: () => T[];
    orderBy: (fct: (element: T) => any, fct2?: (element: T) => any, fct3?: (element: T) => any) => any[];
    orderByDescending: (fct: (element: T) => any, fct2?: (element: T) => any, fct3?: (element: T) => any) => any[];
    select: (fct: (element: T) => any) => any[];
    selectMany: (fct: (element: T) => any[]) => any[];
    single: (fct?: (element: T) => any) => T;
    singleOrDefault: (fct?: (element: T) => any) => T | null;
    skip: (nr: number) => T[];
    skipWhile: (fct: (element: T) => boolean) => T[];
    sum: (fct?: (element: T) => number) => number;
    take: (nr: number) => T[];
    takeWhile: (fct: (element: T) => boolean) => T[];
    toDictionary: (keySelector: (element: T) => any, valueSelector?: (element: T) => any) => any;
    where: (fct: (element: T) => boolean) => T[];
  }
}

Array.prototype.any = function(fct) {
  const len = fct ? this.filter(x => fct(x)).length : this.length;
  return len > 0;
};

Array.prototype.average = function(fct) {
  // if (this.length === 0) throw { message: 'average() of empty array not possible!' };
  if (this.length === 0) return 0;
  const nr = this.length;
  const sum = this.reduce((sum, x) => sum + (fct ? fct(x) : x), 0);
  return sum / nr;
};

Array.prototype.count = function() {
  return this.length;
};

Array.prototype.distinct = function() {
  return [...new Set(this)];
  // if problems with terser, use next lines:
  // return this.reduce((set, x) => {
  //   if (set.indexOf(x) < 0) set.push(x);
  //   return set;
  // }, [])
};

Array.prototype.distinctBy = function(fct) {
  const map = new Map<number | string, any>();
  this.forEach(x => {
    const key = fct(x);
    if (!map.has(key)) map.set(key, x);
  });
  return [...map.values()];
  // if problems with terser, use next lines:
  // const arr = [];
  // for (const item of map.values()) {
  //   arr.push(item);
  // }
  // return arr;
};

Array.prototype.first = function(fct) {
  if (this.length === 0) throw { message: 'first() of empty array not possible!' };
  return fct ? fct(this[0]) : this[0];
};

Array.prototype.firstOrDefault = function(fct) {
  const filtered = fct ? this.filter(fct) : this;
  return filtered.length === 0 ? null : filtered[0];
};

Array.prototype.groupBy = function(keySelector, valueSelector) {
  const dict: { [key: string | number]: any } = {};
  if (!valueSelector) valueSelector = x => x;
  for (const item of this) {
    const key = keySelector(item);
    const val = valueSelector(item);
    if (!dict[key]) dict[key] = [];
    (dict[key] as any[]).push(val);
  }
  return dict;
};

Array.prototype.last = function(fct) {
  if (this.length === 0) throw { message: 'last() of empty array not possible!' };
  const last = this[this.length - 1];
  return fct ? fct(last) : last;
};

Array.prototype.median = function() {
  const nr = this.length;
  const middleIndex = Math.floor(nr / 2);
  return [...this].orderBy(x => x)[middleIndex]; //do not change order of this!
};

Array.prototype.min = function(fct) {
  if (this.length === 0) throw { message: 'min() of empty array not possible!' };
  return this.reduce((min, x) => Math.min(min, fct ? fct(x) : x), Number.MAX_VALUE);
};

Array.prototype.max = function(fct) {
  if (this.length === 0) throw { message: 'max() of empty array not possible!' };
  return this.reduce((max, x) => Math.max(max, fct ? fct(x) : x), -Number.MAX_VALUE);
};

Array.prototype.order = function() {
  return this.orderBy(x => x);
}

Array.prototype.orderBy = function(...fcts) {
  return sortImpl(this, 1, fcts);
};

Array.prototype.orderByDescending = function(...fcts) {
  return sortImpl(this, -1, fcts);
};

function sortImpl(arr: any[], sortFlag: 1 | -1, fcts: any[]) {
  const cascadeSorter = (x: any, y: any) => {
    for (const f of fcts) {
      if (f!(x) === f!(y)) continue;
      else return f!(x) > f!(y) ? sortFlag : sortFlag * (-1);
    }
    return 0;
  };
  return arr.sort(cascadeSorter);
};

Array.prototype.orderDescending = function() {
  return this.orderByDescending(x => x);
}

Array.prototype.select = Array.prototype.map;

Array.prototype.selectMany = function(fct) {
  const arr = [];
  for (const item of this) {
    for (const s of fct(item)) {
      arr.push(s);
    }
  }
  return arr;
};

Array.prototype.single = function(fct) {
  if (!fct) fct = _ => true;
  const matched = this.filter(x => fct!(x));
  const nr = matched.length;
  if (nr !== 1) throw { message: `Number of matched elements is ${nr} != 1` };
  return matched[0];
};

Array.prototype.singleOrDefault = function(fct) {
  if (!fct) fct = _ => true;
  const matched = this.filter(x => fct!(x));
  const nr = matched.length;
  if (nr === 0) return null;
  if (nr !== 1) throw { message: `Number of matched elements is ${nr} != 1` };
  return matched[0];
};

Array.prototype.skip = function(nr) {
  return this.slice(nr);
};

Array.prototype.skipWhile = function(fct) {
  let startIndex = 0;
  for (const element of this) {
    if (!fct(element)) break;
    startIndex++;
  }
  return this.slice(startIndex);
};

Array.prototype.sum = function(fct) {
  return this.reduce((sum, x) => sum + (fct ? fct(x) : x), 0);
};

Array.prototype.take = function(nr) {
  return this.slice(0, nr);
};

Array.prototype.takeWhile = function(fct) {
  const taken = [];
  for (const element of this) {
    if (!fct(element)) break;
    taken.push(element);
  }
  return taken;
};

Array.prototype.toDictionary = function(keySelector, valueSelector) {
  if (!valueSelector) valueSelector = x => x;
  const dict: { [key: string | number]: any } = {};
  for (const item of this) {
    dict[keySelector(item)] = valueSelector(item);
  }
  return dict;
};

Array.prototype.where = Array.prototype.filter;

/***************************************************************************************************
 * Array static function prototypes
 ***************************************************************************************************/
declare global {
  interface ArrayConstructor {
    Range: (nr: number, firstVal?: number) => number[];
  }
}

Array.Range = function(nr: number, firstVal: number = 0) {
  if (!firstVal) firstVal = 0;
  return [...Array(nr).keys()].map(x => x + firstVal);
  // if problems with terser, use next lines:
  // const arr = [];
  // for (let i = firstVal; i < nr + firstVal; i++) {
  //   arr.push(i);
  // }
  // return arr;
};
