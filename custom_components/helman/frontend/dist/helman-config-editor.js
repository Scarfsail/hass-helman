/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const Q = globalThis, pe = Q.ShadowRoot && (Q.ShadyCSS === void 0 || Q.ShadyCSS.nativeShadow) && "adoptedStyleSheets" in Document.prototype && "replace" in CSSStyleSheet.prototype, he = Symbol(), me = /* @__PURE__ */ new WeakMap();
let He = class {
  constructor(e, t, i) {
    if (this._$cssResult$ = !0, i !== he) throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");
    this.cssText = e, this.t = t;
  }
  get styleSheet() {
    let e = this.o;
    const t = this.t;
    if (pe && e === void 0) {
      const i = t !== void 0 && t.length === 1;
      i && (e = me.get(t)), e === void 0 && ((this.o = e = new CSSStyleSheet()).replaceSync(this.cssText), i && me.set(t, e));
    }
    return e;
  }
  toString() {
    return this.cssText;
  }
};
const rt = (s) => new He(typeof s == "string" ? s : s + "", void 0, he), st = (s, ...e) => {
  const t = s.length === 1 ? s[0] : e.reduce((i, r, o) => i + ((a) => {
    if (a._$cssResult$ === !0) return a.cssText;
    if (typeof a == "number") return a;
    throw Error("Value passed to 'css' function must be a 'css' function result: " + a + ". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.");
  })(r) + s[o + 1], s[0]);
  return new He(t, s, he);
}, ot = (s, e) => {
  if (pe) s.adoptedStyleSheets = e.map((t) => t instanceof CSSStyleSheet ? t : t.styleSheet);
  else for (const t of e) {
    const i = document.createElement("style"), r = Q.litNonce;
    r !== void 0 && i.setAttribute("nonce", r), i.textContent = t.cssText, s.appendChild(i);
  }
}, ye = pe ? (s) => s : (s) => s instanceof CSSStyleSheet ? ((e) => {
  let t = "";
  for (const i of e.cssRules) t += i.cssText;
  return rt(t);
})(s) : s;
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const { is: at, defineProperty: nt, getOwnPropertyDescriptor: dt, getOwnPropertyNames: lt, getOwnPropertySymbols: ct, getPrototypeOf: _t } = Object, M = globalThis, ve = M.trustedTypes, pt = ve ? ve.emptyScript : "", ie = M.reactiveElementPolyfillSupport, H = (s, e) => s, de = { toAttribute(s, e) {
  switch (e) {
    case Boolean:
      s = s ? pt : null;
      break;
    case Object:
    case Array:
      s = s == null ? s : JSON.stringify(s);
  }
  return s;
}, fromAttribute(s, e) {
  let t = s;
  switch (e) {
    case Boolean:
      t = s !== null;
      break;
    case Number:
      t = s === null ? null : Number(s);
      break;
    case Object:
    case Array:
      try {
        t = JSON.parse(s);
      } catch {
        t = null;
      }
  }
  return t;
} }, Ke = (s, e) => !at(s, e), fe = { attribute: !0, type: String, converter: de, reflect: !1, useDefault: !1, hasChanged: Ke };
Symbol.metadata ?? (Symbol.metadata = Symbol("metadata")), M.litPropertyMetadata ?? (M.litPropertyMetadata = /* @__PURE__ */ new WeakMap());
let T = class extends HTMLElement {
  static addInitializer(e) {
    this._$Ei(), (this.l ?? (this.l = [])).push(e);
  }
  static get observedAttributes() {
    return this.finalize(), this._$Eh && [...this._$Eh.keys()];
  }
  static createProperty(e, t = fe) {
    if (t.state && (t.attribute = !1), this._$Ei(), this.prototype.hasOwnProperty(e) && ((t = Object.create(t)).wrapped = !0), this.elementProperties.set(e, t), !t.noAccessor) {
      const i = Symbol(), r = this.getPropertyDescriptor(e, i, t);
      r !== void 0 && nt(this.prototype, e, r);
    }
  }
  static getPropertyDescriptor(e, t, i) {
    const { get: r, set: o } = dt(this.prototype, e) ?? { get() {
      return this[t];
    }, set(a) {
      this[t] = a;
    } };
    return { get: r, set(a) {
      const d = r == null ? void 0 : r.call(this);
      o == null || o.call(this, a), this.requestUpdate(e, d, i);
    }, configurable: !0, enumerable: !0 };
  }
  static getPropertyOptions(e) {
    return this.elementProperties.get(e) ?? fe;
  }
  static _$Ei() {
    if (this.hasOwnProperty(H("elementProperties"))) return;
    const e = _t(this);
    e.finalize(), e.l !== void 0 && (this.l = [...e.l]), this.elementProperties = new Map(e.elementProperties);
  }
  static finalize() {
    if (this.hasOwnProperty(H("finalized"))) return;
    if (this.finalized = !0, this._$Ei(), this.hasOwnProperty(H("properties"))) {
      const t = this.properties, i = [...lt(t), ...ct(t)];
      for (const r of i) this.createProperty(r, t[r]);
    }
    const e = this[Symbol.metadata];
    if (e !== null) {
      const t = litPropertyMetadata.get(e);
      if (t !== void 0) for (const [i, r] of t) this.elementProperties.set(i, r);
    }
    this._$Eh = /* @__PURE__ */ new Map();
    for (const [t, i] of this.elementProperties) {
      const r = this._$Eu(t, i);
      r !== void 0 && this._$Eh.set(r, t);
    }
    this.elementStyles = this.finalizeStyles(this.styles);
  }
  static finalizeStyles(e) {
    const t = [];
    if (Array.isArray(e)) {
      const i = new Set(e.flat(1 / 0).reverse());
      for (const r of i) t.unshift(ye(r));
    } else e !== void 0 && t.push(ye(e));
    return t;
  }
  static _$Eu(e, t) {
    const i = t.attribute;
    return i === !1 ? void 0 : typeof i == "string" ? i : typeof e == "string" ? e.toLowerCase() : void 0;
  }
  constructor() {
    super(), this._$Ep = void 0, this.isUpdatePending = !1, this.hasUpdated = !1, this._$Em = null, this._$Ev();
  }
  _$Ev() {
    var e;
    this._$ES = new Promise((t) => this.enableUpdating = t), this._$AL = /* @__PURE__ */ new Map(), this._$E_(), this.requestUpdate(), (e = this.constructor.l) == null || e.forEach((t) => t(this));
  }
  addController(e) {
    var t;
    (this._$EO ?? (this._$EO = /* @__PURE__ */ new Set())).add(e), this.renderRoot !== void 0 && this.isConnected && ((t = e.hostConnected) == null || t.call(e));
  }
  removeController(e) {
    var t;
    (t = this._$EO) == null || t.delete(e);
  }
  _$E_() {
    const e = /* @__PURE__ */ new Map(), t = this.constructor.elementProperties;
    for (const i of t.keys()) this.hasOwnProperty(i) && (e.set(i, this[i]), delete this[i]);
    e.size > 0 && (this._$Ep = e);
  }
  createRenderRoot() {
    const e = this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
    return ot(e, this.constructor.elementStyles), e;
  }
  connectedCallback() {
    var e;
    this.renderRoot ?? (this.renderRoot = this.createRenderRoot()), this.enableUpdating(!0), (e = this._$EO) == null || e.forEach((t) => {
      var i;
      return (i = t.hostConnected) == null ? void 0 : i.call(t);
    });
  }
  enableUpdating(e) {
  }
  disconnectedCallback() {
    var e;
    (e = this._$EO) == null || e.forEach((t) => {
      var i;
      return (i = t.hostDisconnected) == null ? void 0 : i.call(t);
    });
  }
  attributeChangedCallback(e, t, i) {
    this._$AK(e, i);
  }
  _$ET(e, t) {
    var o;
    const i = this.constructor.elementProperties.get(e), r = this.constructor._$Eu(e, i);
    if (r !== void 0 && i.reflect === !0) {
      const a = (((o = i.converter) == null ? void 0 : o.toAttribute) !== void 0 ? i.converter : de).toAttribute(t, i.type);
      this._$Em = e, a == null ? this.removeAttribute(r) : this.setAttribute(r, a), this._$Em = null;
    }
  }
  _$AK(e, t) {
    var o, a;
    const i = this.constructor, r = i._$Eh.get(e);
    if (r !== void 0 && this._$Em !== r) {
      const d = i.getPropertyOptions(r), n = typeof d.converter == "function" ? { fromAttribute: d.converter } : ((o = d.converter) == null ? void 0 : o.fromAttribute) !== void 0 ? d.converter : de;
      this._$Em = r;
      const c = n.fromAttribute(t, d.type);
      this[r] = c ?? ((a = this._$Ej) == null ? void 0 : a.get(r)) ?? c, this._$Em = null;
    }
  }
  requestUpdate(e, t, i, r = !1, o) {
    var a;
    if (e !== void 0) {
      const d = this.constructor;
      if (r === !1 && (o = this[e]), i ?? (i = d.getPropertyOptions(e)), !((i.hasChanged ?? Ke)(o, t) || i.useDefault && i.reflect && o === ((a = this._$Ej) == null ? void 0 : a.get(e)) && !this.hasAttribute(d._$Eu(e, i)))) return;
      this.C(e, t, i);
    }
    this.isUpdatePending === !1 && (this._$ES = this._$EP());
  }
  C(e, t, { useDefault: i, reflect: r, wrapped: o }, a) {
    i && !(this._$Ej ?? (this._$Ej = /* @__PURE__ */ new Map())).has(e) && (this._$Ej.set(e, a ?? t ?? this[e]), o !== !0 || a !== void 0) || (this._$AL.has(e) || (this.hasUpdated || i || (t = void 0), this._$AL.set(e, t)), r === !0 && this._$Em !== e && (this._$Eq ?? (this._$Eq = /* @__PURE__ */ new Set())).add(e));
  }
  async _$EP() {
    this.isUpdatePending = !0;
    try {
      await this._$ES;
    } catch (t) {
      Promise.reject(t);
    }
    const e = this.scheduleUpdate();
    return e != null && await e, !this.isUpdatePending;
  }
  scheduleUpdate() {
    return this.performUpdate();
  }
  performUpdate() {
    var i;
    if (!this.isUpdatePending) return;
    if (!this.hasUpdated) {
      if (this.renderRoot ?? (this.renderRoot = this.createRenderRoot()), this._$Ep) {
        for (const [o, a] of this._$Ep) this[o] = a;
        this._$Ep = void 0;
      }
      const r = this.constructor.elementProperties;
      if (r.size > 0) for (const [o, a] of r) {
        const { wrapped: d } = a, n = this[o];
        d !== !0 || this._$AL.has(o) || n === void 0 || this.C(o, void 0, a, n);
      }
    }
    let e = !1;
    const t = this._$AL;
    try {
      e = this.shouldUpdate(t), e ? (this.willUpdate(t), (i = this._$EO) == null || i.forEach((r) => {
        var o;
        return (o = r.hostUpdate) == null ? void 0 : o.call(r);
      }), this.update(t)) : this._$EM();
    } catch (r) {
      throw e = !1, this._$EM(), r;
    }
    e && this._$AE(t);
  }
  willUpdate(e) {
  }
  _$AE(e) {
    var t;
    (t = this._$EO) == null || t.forEach((i) => {
      var r;
      return (r = i.hostUpdated) == null ? void 0 : r.call(i);
    }), this.hasUpdated || (this.hasUpdated = !0, this.firstUpdated(e)), this.updated(e);
  }
  _$EM() {
    this._$AL = /* @__PURE__ */ new Map(), this.isUpdatePending = !1;
  }
  get updateComplete() {
    return this.getUpdateComplete();
  }
  getUpdateComplete() {
    return this._$ES;
  }
  shouldUpdate(e) {
    return !0;
  }
  update(e) {
    this._$Eq && (this._$Eq = this._$Eq.forEach((t) => this._$ET(t, this[t]))), this._$EM();
  }
  updated(e) {
  }
  firstUpdated(e) {
  }
};
T.elementStyles = [], T.shadowRootOptions = { mode: "open" }, T[H("elementProperties")] = /* @__PURE__ */ new Map(), T[H("finalized")] = /* @__PURE__ */ new Map(), ie == null || ie({ ReactiveElement: T }), (M.reactiveElementVersions ?? (M.reactiveElementVersions = [])).push("2.1.2");
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const K = globalThis, be = (s) => s, X = K.trustedTypes, $e = X ? X.createPolicy("lit-html", { createHTML: (s) => s }) : void 0, Be = "$lit$", O = `lit$${Math.random().toFixed(9).slice(2)}$`, qe = "?" + O, ht = `<${qe}>`, P = document, W = () => P.createComment(""), J = (s) => s === null || typeof s != "object" && typeof s != "function", ue = Array.isArray, ut = (s) => ue(s) || typeof (s == null ? void 0 : s[Symbol.iterator]) == "function", re = `[ 	
\f\r]`, F = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g, we = /-->/g, ke = />/g, C = RegExp(`>|${re}(?:([^\\s"'>=/]+)(${re}*=${re}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`, "g"), xe = /'/g, Ae = /"/g, We = /^(?:script|style|textarea|title)$/i, gt = (s) => (e, ...t) => ({ _$litType$: s, strings: e, values: t }), l = gt(1), L = Symbol.for("lit-noChange"), h = Symbol.for("lit-nothing"), Ee = /* @__PURE__ */ new WeakMap(), j = P.createTreeWalker(P, 129);
function Je(s, e) {
  if (!ue(s) || !s.hasOwnProperty("raw")) throw Error("invalid template strings array");
  return $e !== void 0 ? $e.createHTML(e) : e;
}
const mt = (s, e) => {
  const t = s.length - 1, i = [];
  let r, o = e === 2 ? "<svg>" : e === 3 ? "<math>" : "", a = F;
  for (let d = 0; d < t; d++) {
    const n = s[d];
    let c, _, p = -1, b = 0;
    for (; b < n.length && (a.lastIndex = b, _ = a.exec(n), _ !== null); ) b = a.lastIndex, a === F ? _[1] === "!--" ? a = we : _[1] !== void 0 ? a = ke : _[2] !== void 0 ? (We.test(_[2]) && (r = RegExp("</" + _[2], "g")), a = C) : _[3] !== void 0 && (a = C) : a === C ? _[0] === ">" ? (a = r ?? F, p = -1) : _[1] === void 0 ? p = -2 : (p = a.lastIndex - _[2].length, c = _[1], a = _[3] === void 0 ? C : _[3] === '"' ? Ae : xe) : a === Ae || a === xe ? a = C : a === we || a === ke ? a = F : (a = C, r = void 0);
    const x = a === C && s[d + 1].startsWith("/>") ? " " : "";
    o += a === F ? n + ht : p >= 0 ? (i.push(c), n.slice(0, p) + Be + n.slice(p) + O + x) : n + O + (p === -2 ? d : x);
  }
  return [Je(s, o + (s[t] || "<?>") + (e === 2 ? "</svg>" : e === 3 ? "</math>" : "")), i];
};
class G {
  constructor({ strings: e, _$litType$: t }, i) {
    let r;
    this.parts = [];
    let o = 0, a = 0;
    const d = e.length - 1, n = this.parts, [c, _] = mt(e, t);
    if (this.el = G.createElement(c, i), j.currentNode = this.el.content, t === 2 || t === 3) {
      const p = this.el.content.firstChild;
      p.replaceWith(...p.childNodes);
    }
    for (; (r = j.nextNode()) !== null && n.length < d; ) {
      if (r.nodeType === 1) {
        if (r.hasAttributes()) for (const p of r.getAttributeNames()) if (p.endsWith(Be)) {
          const b = _[a++], x = r.getAttribute(p).split(O), Z = /([.?@])?(.*)/.exec(b);
          n.push({ type: 1, index: o, name: Z[2], strings: x, ctor: Z[1] === "." ? vt : Z[1] === "?" ? ft : Z[1] === "@" ? bt : te }), r.removeAttribute(p);
        } else p.startsWith(O) && (n.push({ type: 6, index: o }), r.removeAttribute(p));
        if (We.test(r.tagName)) {
          const p = r.textContent.split(O), b = p.length - 1;
          if (b > 0) {
            r.textContent = X ? X.emptyScript : "";
            for (let x = 0; x < b; x++) r.append(p[x], W()), j.nextNode(), n.push({ type: 2, index: ++o });
            r.append(p[b], W());
          }
        }
      } else if (r.nodeType === 8) if (r.data === qe) n.push({ type: 2, index: o });
      else {
        let p = -1;
        for (; (p = r.data.indexOf(O, p + 1)) !== -1; ) n.push({ type: 7, index: o }), p += O.length - 1;
      }
      o++;
    }
  }
  static createElement(e, t) {
    const i = P.createElement("template");
    return i.innerHTML = e, i;
  }
}
function R(s, e, t = s, i) {
  var a, d;
  if (e === L) return e;
  let r = i !== void 0 ? (a = t._$Co) == null ? void 0 : a[i] : t._$Cl;
  const o = J(e) ? void 0 : e._$litDirective$;
  return (r == null ? void 0 : r.constructor) !== o && ((d = r == null ? void 0 : r._$AO) == null || d.call(r, !1), o === void 0 ? r = void 0 : (r = new o(s), r._$AT(s, t, i)), i !== void 0 ? (t._$Co ?? (t._$Co = []))[i] = r : t._$Cl = r), r !== void 0 && (e = R(s, r._$AS(s, e.values), r, i)), e;
}
class yt {
  constructor(e, t) {
    this._$AV = [], this._$AN = void 0, this._$AD = e, this._$AM = t;
  }
  get parentNode() {
    return this._$AM.parentNode;
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  u(e) {
    const { el: { content: t }, parts: i } = this._$AD, r = ((e == null ? void 0 : e.creationScope) ?? P).importNode(t, !0);
    j.currentNode = r;
    let o = j.nextNode(), a = 0, d = 0, n = i[0];
    for (; n !== void 0; ) {
      if (a === n.index) {
        let c;
        n.type === 2 ? c = new Y(o, o.nextSibling, this, e) : n.type === 1 ? c = new n.ctor(o, n.name, n.strings, this, e) : n.type === 6 && (c = new $t(o, this, e)), this._$AV.push(c), n = i[++d];
      }
      a !== (n == null ? void 0 : n.index) && (o = j.nextNode(), a++);
    }
    return j.currentNode = P, r;
  }
  p(e) {
    let t = 0;
    for (const i of this._$AV) i !== void 0 && (i.strings !== void 0 ? (i._$AI(e, i, t), t += i.strings.length - 2) : i._$AI(e[t])), t++;
  }
}
class Y {
  get _$AU() {
    var e;
    return ((e = this._$AM) == null ? void 0 : e._$AU) ?? this._$Cv;
  }
  constructor(e, t, i, r) {
    this.type = 2, this._$AH = h, this._$AN = void 0, this._$AA = e, this._$AB = t, this._$AM = i, this.options = r, this._$Cv = (r == null ? void 0 : r.isConnected) ?? !0;
  }
  get parentNode() {
    let e = this._$AA.parentNode;
    const t = this._$AM;
    return t !== void 0 && (e == null ? void 0 : e.nodeType) === 11 && (e = t.parentNode), e;
  }
  get startNode() {
    return this._$AA;
  }
  get endNode() {
    return this._$AB;
  }
  _$AI(e, t = this) {
    e = R(this, e, t), J(e) ? e === h || e == null || e === "" ? (this._$AH !== h && this._$AR(), this._$AH = h) : e !== this._$AH && e !== L && this._(e) : e._$litType$ !== void 0 ? this.$(e) : e.nodeType !== void 0 ? this.T(e) : ut(e) ? this.k(e) : this._(e);
  }
  O(e) {
    return this._$AA.parentNode.insertBefore(e, this._$AB);
  }
  T(e) {
    this._$AH !== e && (this._$AR(), this._$AH = this.O(e));
  }
  _(e) {
    this._$AH !== h && J(this._$AH) ? this._$AA.nextSibling.data = e : this.T(P.createTextNode(e)), this._$AH = e;
  }
  $(e) {
    var o;
    const { values: t, _$litType$: i } = e, r = typeof i == "number" ? this._$AC(e) : (i.el === void 0 && (i.el = G.createElement(Je(i.h, i.h[0]), this.options)), i);
    if (((o = this._$AH) == null ? void 0 : o._$AD) === r) this._$AH.p(t);
    else {
      const a = new yt(r, this), d = a.u(this.options);
      a.p(t), this.T(d), this._$AH = a;
    }
  }
  _$AC(e) {
    let t = Ee.get(e.strings);
    return t === void 0 && Ee.set(e.strings, t = new G(e)), t;
  }
  k(e) {
    ue(this._$AH) || (this._$AH = [], this._$AR());
    const t = this._$AH;
    let i, r = 0;
    for (const o of e) r === t.length ? t.push(i = new Y(this.O(W()), this.O(W()), this, this.options)) : i = t[r], i._$AI(o), r++;
    r < t.length && (this._$AR(i && i._$AB.nextSibling, r), t.length = r);
  }
  _$AR(e = this._$AA.nextSibling, t) {
    var i;
    for ((i = this._$AP) == null ? void 0 : i.call(this, !1, !0, t); e !== this._$AB; ) {
      const r = be(e).nextSibling;
      be(e).remove(), e = r;
    }
  }
  setConnected(e) {
    var t;
    this._$AM === void 0 && (this._$Cv = e, (t = this._$AP) == null || t.call(this, e));
  }
}
class te {
  get tagName() {
    return this.element.tagName;
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  constructor(e, t, i, r, o) {
    this.type = 1, this._$AH = h, this._$AN = void 0, this.element = e, this.name = t, this._$AM = r, this.options = o, i.length > 2 || i[0] !== "" || i[1] !== "" ? (this._$AH = Array(i.length - 1).fill(new String()), this.strings = i) : this._$AH = h;
  }
  _$AI(e, t = this, i, r) {
    const o = this.strings;
    let a = !1;
    if (o === void 0) e = R(this, e, t, 0), a = !J(e) || e !== this._$AH && e !== L, a && (this._$AH = e);
    else {
      const d = e;
      let n, c;
      for (e = o[0], n = 0; n < o.length - 1; n++) c = R(this, d[i + n], t, n), c === L && (c = this._$AH[n]), a || (a = !J(c) || c !== this._$AH[n]), c === h ? e = h : e !== h && (e += (c ?? "") + o[n + 1]), this._$AH[n] = c;
    }
    a && !r && this.j(e);
  }
  j(e) {
    e === h ? this.element.removeAttribute(this.name) : this.element.setAttribute(this.name, e ?? "");
  }
}
class vt extends te {
  constructor() {
    super(...arguments), this.type = 3;
  }
  j(e) {
    this.element[this.name] = e === h ? void 0 : e;
  }
}
class ft extends te {
  constructor() {
    super(...arguments), this.type = 4;
  }
  j(e) {
    this.element.toggleAttribute(this.name, !!e && e !== h);
  }
}
class bt extends te {
  constructor(e, t, i, r, o) {
    super(e, t, i, r, o), this.type = 5;
  }
  _$AI(e, t = this) {
    if ((e = R(this, e, t, 0) ?? h) === L) return;
    const i = this._$AH, r = e === h && i !== h || e.capture !== i.capture || e.once !== i.once || e.passive !== i.passive, o = e !== h && (i === h || r);
    r && this.element.removeEventListener(this.name, this, i), o && this.element.addEventListener(this.name, this, e), this._$AH = e;
  }
  handleEvent(e) {
    var t;
    typeof this._$AH == "function" ? this._$AH.call(((t = this.options) == null ? void 0 : t.host) ?? this.element, e) : this._$AH.handleEvent(e);
  }
}
class $t {
  constructor(e, t, i) {
    this.element = e, this.type = 6, this._$AN = void 0, this._$AM = t, this.options = i;
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  _$AI(e) {
    R(this, e);
  }
}
const wt = { I: Y }, se = K.litHtmlPolyfillSupport;
se == null || se(G, Y), (K.litHtmlVersions ?? (K.litHtmlVersions = [])).push("3.3.2");
const Ge = (s, e, t) => {
  const i = (t == null ? void 0 : t.renderBefore) ?? e;
  let r = i._$litPart$;
  if (r === void 0) {
    const o = (t == null ? void 0 : t.renderBefore) ?? null;
    i._$litPart$ = r = new Y(e.insertBefore(W(), o), o, void 0, t ?? {});
  }
  return r._$AI(s), r;
};
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const V = globalThis;
let B = class extends T {
  constructor() {
    super(...arguments), this.renderOptions = { host: this }, this._$Do = void 0;
  }
  createRenderRoot() {
    var t;
    const e = super.createRenderRoot();
    return (t = this.renderOptions).renderBefore ?? (t.renderBefore = e.firstChild), e;
  }
  update(e) {
    const t = this.render();
    this.hasUpdated || (this.renderOptions.isConnected = this.isConnected), super.update(e), this._$Do = Ge(t, this.renderRoot, this.renderOptions);
  }
  connectedCallback() {
    var e;
    super.connectedCallback(), (e = this._$Do) == null || e.setConnected(!0);
  }
  disconnectedCallback() {
    var e;
    super.disconnectedCallback(), (e = this._$Do) == null || e.setConnected(!1);
  }
  render() {
    return L;
  }
};
var Ue;
B._$litElement$ = !0, B.finalized = !0, (Ue = V.litElementHydrateSupport) == null || Ue.call(V, { LitElement: B });
const oe = V.litElementPolyfillSupport;
oe == null || oe({ LitElement: B });
(V.litElementVersions ?? (V.litElementVersions = [])).push("4.2.2");
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const kt = (s) => (...e) => ({ _$litDirective$: s, values: e });
let xt = class {
  constructor(e) {
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  _$AT(e, t, i) {
    this._$Ct = e, this._$AM = t, this._$Ci = i;
  }
  _$AS(e, t) {
    return this.update(e, t);
  }
  update(e, t) {
    return this.render(...t);
  }
};
/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const { I: At } = wt, Se = (s) => s, Oe = (s, e) => (s == null ? void 0 : s._$litType$) !== void 0, Et = (s) => {
  var e;
  return ((e = s == null ? void 0 : s._$litType$) == null ? void 0 : e.h) != null;
}, Me = () => document.createComment(""), Ce = (s, e, t) => {
  var o;
  const i = s._$AA.parentNode, r = s._$AB;
  if (t === void 0) {
    const a = i.insertBefore(Me(), r), d = i.insertBefore(Me(), r);
    t = new At(a, d, s, s.options);
  } else {
    const a = t._$AB.nextSibling, d = t._$AM, n = d !== s;
    if (n) {
      let c;
      (o = t._$AQ) == null || o.call(t, s), t._$AM = s, t._$AP !== void 0 && (c = s._$AU) !== d._$AU && t._$AP(c);
    }
    if (a !== r || n) {
      let c = t._$AA;
      for (; c !== a; ) {
        const _ = Se(c).nextSibling;
        Se(i).insertBefore(c, r), c = _;
      }
    }
  }
  return t;
}, St = {}, je = (s, e = St) => s._$AH = e, Ve = (s) => s._$AH, Ot = (s) => {
  s._$AR();
};
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const Pe = (s) => Et(s) ? s._$litType$.h : s.strings, Mt = kt(class extends xt {
  constructor(s) {
    super(s), this.et = /* @__PURE__ */ new WeakMap();
  }
  render(s) {
    return [s];
  }
  update(s, [e]) {
    const t = Oe(this.it) ? Pe(this.it) : null, i = Oe(e) ? Pe(e) : null;
    if (t !== null && (i === null || t !== i)) {
      const r = Ve(s).pop();
      let o = this.et.get(t);
      if (o === void 0) {
        const a = document.createDocumentFragment();
        o = Ge(h, a), o.setConnected(!1), this.et.set(t, o);
      }
      je(o, [r]), Ce(o, void 0, r);
    }
    if (i !== null) {
      if (t === null || t !== i) {
        const r = this.et.get(i);
        if (r !== void 0) {
          const o = Ve(r).pop();
          Ot(s), Ce(s, void 0, o), je(s, [o]);
        }
      }
      this.it = e;
    } else this.it = void 0;
    return this.render(e);
  }
});
function y(s) {
  return typeof structuredClone == "function" ? structuredClone(s) : JSON.parse(JSON.stringify(s));
}
function w(s) {
  return typeof s == "object" && s !== null && !Array.isArray(s);
}
function f(s) {
  return w(s) ? s : void 0;
}
function A(s) {
  return Array.isArray(s) ? s : void 0;
}
function E(s) {
  const e = f(s);
  return e ? Object.entries(e) : [];
}
function k(s, e) {
  let t = s;
  for (const i of e) {
    if (typeof i == "number") {
      if (!Array.isArray(t))
        return;
      t = t[i];
      continue;
    }
    if (!w(t))
      return;
    t = t[i];
  }
  return t;
}
function m(s, e, t) {
  if (e.length === 0)
    return;
  let i = s;
  for (let o = 0; o < e.length - 1; o += 1) {
    const a = e[o], n = typeof e[o + 1] == "number";
    if (typeof a == "number") {
      if (!Array.isArray(i))
        return;
      let _ = i[a];
      n ? Array.isArray(_) || (_ = [], i[a] = _) : w(_) || (_ = {}, i[a] = _), i = _;
      continue;
    }
    let c = i[a];
    n ? Array.isArray(c) || (c = [], i[a] = c) : w(c) || (c = {}, i[a] = c), i = c;
  }
  const r = e[e.length - 1];
  if (typeof r == "number") {
    if (!Array.isArray(i))
      return;
    i[r] = t;
    return;
  }
  i[r] = t;
}
function q(s, e) {
  e.length !== 0 && (Qe(s, e), Ut(s, e.slice(0, -1)));
}
function z(s, e, t) {
  const i = k(s, e), o = [...Array.isArray(i) ? i : [], t];
  m(s, e, o);
}
function Ct(s, e, t) {
  const i = k(s, e);
  if (!Array.isArray(i) || t < 0 || t >= i.length)
    return;
  const r = i.filter((o, a) => a !== t);
  if (r.length === 0) {
    q(s, e);
    return;
  }
  m(s, e, r);
}
function jt(s, e, t, i) {
  const r = k(s, e);
  if (!Array.isArray(r) || t < 0 || i < 0 || t >= r.length || i >= r.length || t === i)
    return;
  const o = [...r], [a] = o.splice(t, 1);
  o.splice(i, 0, a), m(s, e, o);
}
function Vt(s, e, t, i) {
  const r = k(s, e);
  if (!w(r))
    return { ok: !1, reason: "target_not_available" };
  const o = i.trim();
  if (!o)
    return { ok: !1, reason: "empty_key" };
  if (o === t)
    return { ok: !0 };
  if (Object.prototype.hasOwnProperty.call(r, o))
    return { ok: !1, reason: "duplicate_key", key: o };
  if (r[t] === void 0)
    return { ok: !1, reason: "missing_key", key: t };
  const d = {};
  for (const [n, c] of Object.entries(r)) {
    if (n === t) {
      d[o] = c;
      continue;
    }
    d[n] = c;
  }
  return m(s, e, d), { ok: !0 };
}
function Pt(s) {
  return N(s, "category");
}
function Tt(s) {
  return N(s, "label");
}
function Lt(s, e, t) {
  return {
    kind: "ev_charger",
    id: N(s, "ev-charger"),
    name: e,
    limits: {
      max_charging_power_kw: 11
    },
    controls: {
      charge: {
        entity_id: ""
      },
      use_mode: {
        entity_id: "",
        values: {
          Fast: {
            behavior: "fixed_max_power"
          },
          ECO: {
            behavior: "surplus_aware"
          }
        }
      },
      eco_gear: {
        entity_id: "",
        values: {
          "6A": {
            min_power_kw: 1.4
          }
        }
      }
    },
    vehicles: [Ze([], t)]
  };
}
function Ze(s, e) {
  return {
    id: N(s, "vehicle"),
    name: e,
    telemetry: {
      soc_entity_id: ""
    },
    limits: {
      battery_capacity_kwh: 64,
      max_charging_power_kw: 11
    }
  };
}
function Rt() {
  return {
    behavior: "fixed_max_power"
  };
}
function Yt() {
  return {
    min_power_kw: 1.4
  };
}
function Nt(s) {
  return {
    energy_entity_id: "",
    label: s
  };
}
function Ft() {
  return {
    start: "00:00",
    end: "06:00",
    price: 1
  };
}
function zt() {
  return "";
}
function Dt(s) {
  return N(s, "mode");
}
function It(s) {
  return N(s, "gear");
}
function Qe(s, e) {
  const t = e.slice(0, -1), i = t.length === 0 ? s : k(s, t);
  if (i === void 0)
    return;
  const r = e[e.length - 1];
  if (typeof r == "number") {
    if (!Array.isArray(i) || r < 0 || r >= i.length)
      return;
    i.splice(r, 1);
    return;
  }
  !w(i) || !(r in i) || delete i[r];
}
function Ut(s, e) {
  for (let t = e.length; t > 0; t -= 1) {
    const i = e.slice(0, t), r = k(s, i), o = w(r) && Object.keys(r).length === 0, a = Array.isArray(r) && r.length === 0;
    if (!o && !a)
      break;
    Qe(s, i);
  }
}
function N(s, e) {
  const t = new Set(s);
  if (!t.has(e))
    return e;
  let i = 2;
  for (; t.has(`${e}-${i}`); )
    i += 1;
  return `${e}-${i}`;
}
function Ht() {
  return {
    read(s) {
      return y(s);
    },
    apply(s, e) {
      return y(e);
    },
    validate(s) {
      return ge(s, "object");
    }
  };
}
function v(s, e) {
  return {
    read(t) {
      const i = s.length === 0 ? t : k(t, s);
      return y(i === void 0 ? e.emptyValue : i);
    },
    apply(t, i) {
      if (s.length === 0)
        return y(i);
      const r = y(t);
      return m(r, s, y(i)), r;
    },
    validate(t) {
      return ge(t, e.rootKind);
    }
  };
}
function Te(s) {
  const e = new Map(s.map((t) => [t.yamlKey, t]));
  return {
    read(t) {
      const i = {};
      for (const r of s) {
        const o = k(t, r.documentPath);
        o !== void 0 && (i[r.yamlKey] = y(o));
      }
      return i;
    },
    apply(t, i) {
      const r = y(t), o = i;
      for (const a of s)
        q(r, a.documentPath);
      for (const a of s) {
        const d = o[a.yamlKey];
        d !== void 0 && m(r, a.documentPath, y(d));
      }
      return r;
    },
    validate(t) {
      const i = ge(t, "object");
      if (i)
        return i;
      if (!w(t))
        return { code: "expected_object" };
      for (const r of Object.keys(t))
        if (!e.has(r))
          return { code: "unexpected_key", key: r };
      return null;
    }
  };
}
function ge(s, e) {
  return e === "array" ? Array.isArray(s) ? null : { code: "expected_array" } : w(s) ? null : { code: "expected_object" };
}
const Kt = [
  { id: "general", labelKey: "editor.tabs.general" },
  { id: "power_devices", labelKey: "editor.tabs.power_devices" },
  { id: "scheduler", labelKey: "editor.tabs.scheduler" },
  { id: "appliances", labelKey: "editor.tabs.appliances" }
], Le = {
  general: "general",
  power_devices: "power_devices",
  scheduler_control: "scheduler",
  appliances: "appliances",
  root: "general"
}, $ = "document", g = {
  general: "tab:general",
  power_devices: "tab:power_devices",
  scheduler: "tab:scheduler",
  appliances: "tab:appliances"
}, u = {
  general: {
    core_labels_and_history: "section:general.core_labels_and_history",
    device_label_text: "section:general.device_label_text"
  },
  power_devices: {
    house: "section:power_devices.house",
    solar: "section:power_devices.solar",
    battery: "section:power_devices.battery",
    grid: "section:power_devices.grid"
  },
  scheduler: {
    schedule_control_mapping: "section:scheduler.schedule_control_mapping"
  },
  appliances: {
    configured_appliances: "section:appliances.configured_appliances"
  }
}, Xe = [
  "history_buckets",
  "history_bucket_duration",
  "sources_title",
  "consumers_title",
  "groups_title",
  "others_group_label",
  "power_sensor_name_cleaner_regex",
  "show_empty_groups",
  "show_others_group",
  "device_label_text"
], Bt = Xe.filter(
  (s) => s !== "device_label_text"
), S = {}, Re = [], qt = et(Xe), Wt = et(
  Bt
), le = {
  [$]: {
    id: $,
    kind: "document",
    labelKey: "editor.title",
    adapter: Ht()
  },
  [g.general]: {
    id: g.general,
    kind: "tab",
    parentId: $,
    tabId: "general",
    labelKey: "editor.tabs.general",
    adapter: Te(qt)
  },
  [g.power_devices]: {
    id: g.power_devices,
    kind: "tab",
    parentId: $,
    tabId: "power_devices",
    labelKey: "editor.tabs.power_devices",
    adapter: v(["power_devices"], {
      emptyValue: S,
      rootKind: "object"
    })
  },
  [g.scheduler]: {
    id: g.scheduler,
    kind: "tab",
    parentId: $,
    tabId: "scheduler",
    labelKey: "editor.tabs.scheduler",
    adapter: v(["scheduler"], {
      emptyValue: S,
      rootKind: "object"
    })
  },
  [g.appliances]: {
    id: g.appliances,
    kind: "tab",
    parentId: $,
    tabId: "appliances",
    labelKey: "editor.tabs.appliances",
    adapter: v(["appliances"], {
      emptyValue: Re,
      rootKind: "array"
    })
  },
  [u.general.core_labels_and_history]: {
    id: u.general.core_labels_and_history,
    kind: "section",
    parentId: g.general,
    tabId: "general",
    labelKey: "editor.sections.core_labels_and_history",
    adapter: Te(Wt)
  },
  [u.general.device_label_text]: {
    id: u.general.device_label_text,
    kind: "section",
    parentId: g.general,
    tabId: "general",
    labelKey: "editor.sections.device_label_text",
    adapter: v(["device_label_text"], {
      emptyValue: S,
      rootKind: "object"
    })
  },
  [u.power_devices.house]: {
    id: u.power_devices.house,
    kind: "section",
    parentId: g.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.house",
    adapter: v(["power_devices", "house"], {
      emptyValue: S,
      rootKind: "object"
    })
  },
  [u.power_devices.solar]: {
    id: u.power_devices.solar,
    kind: "section",
    parentId: g.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.solar",
    adapter: v(["power_devices", "solar"], {
      emptyValue: S,
      rootKind: "object"
    })
  },
  [u.power_devices.battery]: {
    id: u.power_devices.battery,
    kind: "section",
    parentId: g.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.battery",
    adapter: v(["power_devices", "battery"], {
      emptyValue: S,
      rootKind: "object"
    })
  },
  [u.power_devices.grid]: {
    id: u.power_devices.grid,
    kind: "section",
    parentId: g.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.grid",
    adapter: v(["power_devices", "grid"], {
      emptyValue: S,
      rootKind: "object"
    })
  },
  [u.scheduler.schedule_control_mapping]: {
    id: u.scheduler.schedule_control_mapping,
    kind: "section",
    parentId: g.scheduler,
    tabId: "scheduler",
    labelKey: "editor.sections.schedule_control_mapping",
    adapter: v(["scheduler", "control"], {
      emptyValue: S,
      rootKind: "object"
    })
  },
  [u.appliances.configured_appliances]: {
    id: u.appliances.configured_appliances,
    kind: "section",
    parentId: g.appliances,
    tabId: "appliances",
    labelKey: "editor.sections.configured_appliances",
    adapter: v(["appliances"], {
      emptyValue: Re,
      rootKind: "array"
    })
  }
}, Ye = Jt();
function D(s) {
  return le[s];
}
function Ne(s) {
  const e = [], t = [...Ye[s]];
  for (; t.length > 0; ) {
    const i = t.pop();
    i && (e.push(i), t.push(...Ye[i]));
  }
  return e;
}
function et(s) {
  return s.map((e) => ({
    yamlKey: e,
    documentPath: [e]
  }));
}
function Jt() {
  const s = Object.fromEntries(
    Object.keys(le).map((e) => [e, []])
  );
  for (const e of Object.values(le))
    e.parentId && s[e.parentId].push(e.id);
  return s;
}
const tt = {
  title: "Editor konfigurace Helman",
  description: "Upravte uloženou konfiguraci integrace Helman, validujte ji v backendu a uložte ji bez ztráty nepodporovaných klíčů nebo budoucích konfiguračních větví.",
  tabs: {
    general: "Obecné",
    power_devices: "Výkonová zařízení",
    scheduler: "Plánování",
    appliances: "Spotřebiče"
  },
  actions: {
    reload_config: "Načíst uloženou konfiguraci znovu",
    validate: "Validovat",
    validating: "Validuji...",
    save_and_reload: "Uložit a restartovat",
    saving: "Ukládám...",
    add_category: "Přidat kategorii",
    add_badge_text: "Přidat text štítku",
    add_deferrable_consumer: "Přidat odložitelný spotřebič",
    add_daily_energy_entity: "Přidat entitu denní energie",
    add_import_price_window: "Přidat okno ceny importu",
    add_ev_charger: "Přidat EV nabíječku",
    add_vehicle: "Přidat vozidlo",
    add_use_mode: "Přidat režim použití",
    add_eco_gear: "Přidat eco gear",
    remove: "Odstranit",
    remove_category: "Odstranit kategorii",
    up: "Nahoru",
    down: "Dolů"
  },
  status: {
    loading_config: "Načítám uloženou konfiguraci...",
    unsaved_changes: "Neuložené změny",
    stored_config_loaded: "Uložená konfigurace načtena",
    last_validation_passed: "Poslední validace prošla",
    validation_stale: "Výsledek validace je zastaralý, dokud nespustíte validaci nebo uložení",
    fix_yaml_errors: "Před validací nebo uložením opravte chyby v YAML"
  },
  issues: {
    errors: "Chyby",
    warnings: "Varování"
  },
  sections: {
    core_labels_and_history: "Základní popisky a historie",
    device_label_text: "Texty štítků zařízení",
    house: "Dům",
    solar: "Solár",
    battery: "Baterie",
    grid: "Síť",
    schedule_control_mapping: "Mapování ovládání plánování",
    configured_appliances: "Nakonfigurované spotřebiče",
    identity_and_limits: "Identita a limity",
    controls: "Ovládání",
    use_modes: "Režimy použití",
    eco_gears: "Eco gears",
    vehicles: "Vozidla"
  },
  notes: {
    device_label_text: "Nakonfigurujte mapy textů štítků, například místnosti nebo vlastní skupiny štítků. Neznámé kategorie a položky se zachovají.",
    battery_entities: "Remaining energy, capacity, min SoC a max SoC fungují jako jedna skupina bateriových entit. Pokud zapnete predikci baterie, nastavte je společně.",
    grid_import_windows: "Okna cen importu musí pokrývat celý den bez mezer nebo překryvů.",
    appliances: "Editace EV nabíječky je podporovaná přímo. Nepodporované budoucí typy spotřebičů se zachovají a zobrazí jen pro čtení, dokud je neodstraníte."
  },
  empty: {
    no_appliances: "Zatím nejsou nakonfigurovány žádné spotřebiče.",
    no_device_label_categories: "Nejsou nakonfigurovány žádné kategorie textů štítků."
  },
  card: {
    category: "Kategorie",
    badge_text_entry: "Položka textu štítku",
    house_deferrable_consumer: "Odložitelný spotřebič v predikci domu",
    daily_energy_entity: "Entita denní energie",
    import_window: "Importní okno",
    local_time_window: "Lokální časové okno",
    use_mode_mapping: "Mapování režimu použití",
    eco_gear_mapping: "Mapování eco gear"
  },
  fields: {
    history_buckets: "Počet historických bucketů",
    history_bucket_duration: "Délka bucketu historie",
    sources_title: "Název zdrojů",
    consumers_title: "Název spotřebičů",
    groups_title: "Název skupin",
    others_group_label: "Popisek skupiny Ostatní",
    power_sensor_name_cleaner_regex: "Regex pro čištění názvu power senzoru",
    show_empty_groups: "Zobrazit prázdné skupiny",
    show_others_group: "Zobrazit skupinu Ostatní",
    category_key: "Klíč kategorie",
    label_key: "Klíč štítku",
    badge_text: "Text štítku",
    house_power_entity: "Entita výkonu domu",
    power_sensor_label: "Popisek senzoru výkonu",
    power_switch_label: "Popisek přepínače výkonu",
    unmeasured_power_title: "Nadpis neměřeného výkonu",
    forecast_total_energy_entity: "Entita celkové energie pro predikci",
    min_history_days: "Minimální počet dní historie",
    training_window_days: "Počet dní trénovacího okna",
    energy_entity: "Entita energie",
    label: "Popisek",
    power_entity: "Entita výkonu",
    today_energy_entity: "Entita dnešní energie",
    remaining_today_energy_forecast: "Predikce zbývající dnešní energie",
    remaining_energy_entity: "Entita zbývající energie",
    capacity_entity: "Entita kapacity",
    min_soc_entity: "Entita min SoC",
    max_soc_entity: "Entita max SoC",
    charge_efficiency: "Účinnost nabíjení",
    discharge_efficiency: "Účinnost vybíjení",
    max_charge_power_w: "Max. nabíjecí výkon W",
    max_discharge_power_w: "Max. vybíjecí výkon W",
    sell_price_entity: "Entita prodejní ceny",
    import_price_unit: "Jednotka ceny importu",
    start: "Začátek",
    end: "Konec",
    price: "Cena",
    mode_entity: "Entita režimu",
    normal_option: "Volba Normal",
    charge_to_target_soc_option: "Volba Nabít do cílového SoC",
    discharge_to_target_soc_option: "Volba Vybít do cílového SoC",
    stop_charging_option: "Volba Zastavit nabíjení",
    stop_discharging_option: "Volba Zastavit vybíjení",
    appliance_id: "ID spotřebiče",
    appliance_name: "Název spotřebiče",
    kind: "Druh",
    max_charging_power_kw: "Max. nabíjecí výkon kW",
    charge_switch_entity: "Entita přepínače nabíjení",
    use_mode_entity: "Entita režimu použití",
    eco_gear_entity: "Entita eco gear",
    mode_id: "ID režimu",
    behavior: "Chování",
    gear_id: "ID stupně",
    min_power_kw: "Min. výkon kW",
    vehicle_id: "ID vozidla",
    vehicle_name: "Název vozidla",
    soc_entity: "Entita SoC",
    charge_limit_entity: "Entita limitu nabíjení",
    battery_capacity_kwh: "Kapacita baterie kWh",
    entity_id: "ID entity"
  },
  helpers: {
    history_buckets: "Kolik bucketů historie Helman drží pro UI historii.",
    history_bucket_duration: "Délka jednoho bucketu historie v hodinách.",
    power_sensor_name_cleaner_regex: "Volitelný regex použitý při normalizaci názvů power senzorů.",
    import_price_unit: "Např.: CZK/kWh",
    mode_entity: "Helman zapisuje volby akcí plánování do této entity."
  },
  messages: {
    reloaded_config: "Uložená konfigurace Helman byla znovu načtena z backendu.",
    load_config_failed: "Nepodařilo se načíst uloženou konfiguraci Helman.",
    validation_passed: "Validace v backendu prošla.",
    validation_failed: "Validace vrátila chyby backendu. Zkontrolujte seznam problémů níže.",
    validate_config_failed: "Nepodařilo se validovat konfiguraci v backendu.",
    config_saved_reload_started: "Konfigurace byla uložena. Restart Helman byl spuštěn.",
    config_saved: "Konfigurace byla uložena.",
    config_saved_reload_failed: "Konfigurace byla uložena, ale restart Helman selhal.",
    save_rejected: "Uložení bylo odmítnuto, protože backendová validace našla chyby.",
    save_failed: "Nepodařilo se uložit konfiguraci Helman.",
    load_ha_form_failed: "Nepodařilo se načíst formulářové komponenty Home Assistantu.",
    load_ha_yaml_editor_failed: "Nepodařilo se načíst YAML editor Home Assistantu.",
    fix_yaml_errors_first: "Před validací nebo uložením opravte chyby v YAML.",
    fix_descendant_yaml_errors: "Před přepnutím této úrovně do YAML opravte chyby v YAML v podřízených částech.",
    enter_yaml_failed: "Nepodařilo se otevřít YAML editor pro tuto část."
  },
  confirm: {
    discard_changes: "Zahodit neuložené změny a znovu načíst uloženou konfiguraci?"
  },
  rename: {
    target_not_available: "Cílový objekt není k dispozici.",
    key_empty: "Klíč nesmí být prázdný.",
    key_exists: "Klíč {key} už existuje.",
    key_missing: "Klíč {key} neexistuje."
  },
  values: {
    fixed_max_power: "Pevný maximální výkon",
    surplus_aware: "Řízeno přebytkem",
    unknown: "neznámý",
    missing_id: "chybí id"
  },
  mode: {
    visual: "Vizuální",
    yaml: "YAML"
  },
  yaml: {
    field_label: "YAML",
    aria_label: "YAML editor pro {scope}",
    helpers: {
      document: "Upravujete celý konfigurační dokument jako YAML.",
      tab: "Upravujete jako YAML jen větev aktuální karty.",
      section: "Upravujete jako YAML jen větev této sekce."
    },
    errors: {
      fix_before_leaving: "Před návratem do vizuálního režimu opravte chyby v YAML.",
      parse_failed: "Syntaxe YAML v této části není platná.",
      non_json_value: "YAML v této části se musí převést jen na JSON-kompatibilní hodnoty.",
      expected_object: "YAML pro tuto část musí být objekt.",
      expected_array: "YAML pro tuto část musí být seznam.",
      unexpected_key: "Klíč YAML {key} není v této části podporovaný.",
      apply_failed: "Nepodařilo se promítnout YAML změny do této části."
    }
  },
  dynamic: {
    consumer: "Spotřebič {index}",
    daily_energy_entity: "Entita denní energie {index}",
    import_window: "Importní okno {index}",
    appliance: "Spotřebič {index}",
    ev_charger: "EV nabíječka {index}",
    vehicle: "Vozidlo {index}",
    unsupported_appliance_kind: "Nepodporovaný typ spotřebiče: {kind}"
  }
}, Gt = {
  editor: tt
}, Zt = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: Gt,
  editor: tt
}, Symbol.toStringTag, { value: "Module" })), it = {
  title: "Helman config editor",
  description: "Edit the stored Helman integration config, validate it in the backend, and save it without losing unsupported keys or future config branches.",
  tabs: {
    general: "General",
    power_devices: "Power devices",
    scheduler: "Scheduler",
    appliances: "Appliances"
  },
  actions: {
    reload_config: "Reload stored config",
    validate: "Validate",
    validating: "Validating...",
    save_and_reload: "Save and reload",
    saving: "Saving...",
    add_category: "Add category",
    add_badge_text: "Add badge text",
    add_deferrable_consumer: "Add deferrable consumer",
    add_daily_energy_entity: "Add daily energy entity",
    add_import_price_window: "Add import price window",
    add_ev_charger: "Add EV charger",
    add_vehicle: "Add vehicle",
    add_use_mode: "Add use mode",
    add_eco_gear: "Add eco gear",
    remove: "Remove",
    remove_category: "Remove category",
    up: "Up",
    down: "Down"
  },
  status: {
    loading_config: "Loading stored config...",
    unsaved_changes: "Unsaved changes",
    stored_config_loaded: "Stored config loaded",
    last_validation_passed: "Last validation passed",
    validation_stale: "Validation results are stale until you validate or save",
    fix_yaml_errors: "Fix YAML errors before validating or saving"
  },
  issues: {
    errors: "Errors",
    warnings: "Warnings"
  },
  sections: {
    core_labels_and_history: "Core labels and history",
    device_label_text: "Device label text",
    house: "House",
    solar: "Solar",
    battery: "Battery",
    grid: "Grid",
    schedule_control_mapping: "Schedule control mapping",
    configured_appliances: "Configured appliances",
    identity_and_limits: "Identity and limits",
    controls: "Controls",
    use_modes: "Use modes",
    eco_gears: "Eco gears",
    vehicles: "Vehicles"
  },
  notes: {
    device_label_text: "Configure badge text maps such as rooms or custom label groups. Unknown categories and entries are preserved.",
    battery_entities: "Remaining energy, capacity, min SoC, and max SoC work as one battery entity group. Configure them together when battery forecasting is enabled.",
    grid_import_windows: "Import price windows must cover the whole day without gaps or overlaps.",
    appliances: "EV charger editing is supported directly. Unsupported future appliance kinds are preserved and shown read-only unless you remove them."
  },
  empty: {
    no_appliances: "No appliances configured yet.",
    no_device_label_categories: "No device label categories configured."
  },
  card: {
    category: "Category",
    badge_text_entry: "Badge text entry",
    house_deferrable_consumer: "House forecast deferrable consumer",
    daily_energy_entity: "Daily energy entity",
    import_window: "Import window",
    local_time_window: "Local time window",
    use_mode_mapping: "Use mode mapping",
    eco_gear_mapping: "Eco gear mapping"
  },
  fields: {
    history_buckets: "History buckets",
    history_bucket_duration: "History bucket duration",
    sources_title: "Sources title",
    consumers_title: "Consumers title",
    groups_title: "Groups title",
    others_group_label: "Others group label",
    power_sensor_name_cleaner_regex: "Power sensor cleaner regex",
    show_empty_groups: "Show empty groups",
    show_others_group: "Show others group",
    category_key: "Category key",
    label_key: "Label key",
    badge_text: "Badge text",
    house_power_entity: "House power entity",
    power_sensor_label: "Power sensor label",
    power_switch_label: "Power switch label",
    unmeasured_power_title: "Unmeasured power title",
    forecast_total_energy_entity: "Forecast total energy entity",
    min_history_days: "Min history days",
    training_window_days: "Training window days",
    energy_entity: "Energy entity",
    label: "Label",
    power_entity: "Power entity",
    today_energy_entity: "Today energy entity",
    remaining_today_energy_forecast: "Remaining today energy forecast",
    remaining_energy_entity: "Remaining energy entity",
    capacity_entity: "Capacity entity",
    min_soc_entity: "Min SoC entity",
    max_soc_entity: "Max SoC entity",
    charge_efficiency: "Charge efficiency",
    discharge_efficiency: "Discharge efficiency",
    max_charge_power_w: "Max charge power W",
    max_discharge_power_w: "Max discharge power W",
    sell_price_entity: "Sell price entity",
    import_price_unit: "Import price unit",
    start: "Start",
    end: "End",
    price: "Price",
    mode_entity: "Mode entity",
    normal_option: "Normal option",
    charge_to_target_soc_option: "Charge to target SoC option",
    discharge_to_target_soc_option: "Discharge to target SoC option",
    stop_charging_option: "Stop charging option",
    stop_discharging_option: "Stop discharging option",
    appliance_id: "Appliance id",
    appliance_name: "Appliance name",
    kind: "Kind",
    max_charging_power_kw: "Max charging power kW",
    charge_switch_entity: "Charge switch entity",
    use_mode_entity: "Use mode entity",
    eco_gear_entity: "Eco gear entity",
    mode_id: "Mode id",
    behavior: "Behavior",
    gear_id: "Gear id",
    min_power_kw: "Min power kW",
    vehicle_id: "Vehicle id",
    vehicle_name: "Vehicle name",
    soc_entity: "SoC entity",
    charge_limit_entity: "Charge limit entity",
    battery_capacity_kwh: "Battery capacity kWh",
    entity_id: "Entity id"
  },
  helpers: {
    history_buckets: "How many history buckets Helman keeps for UI history.",
    history_bucket_duration: "Duration of one history bucket in hours.",
    power_sensor_name_cleaner_regex: "Optional regex applied when normalizing power sensor names.",
    import_price_unit: "Example: CZK/kWh",
    mode_entity: "Helman writes schedule action options to this entity."
  },
  messages: {
    reloaded_config: "Reloaded the stored Helman config from the backend.",
    load_config_failed: "Failed to load the stored Helman config.",
    validation_passed: "Validation passed in the backend.",
    validation_failed: "Validation returned backend errors. Review the issue list below.",
    validate_config_failed: "Failed to validate the config in the backend.",
    config_saved_reload_started: "Config saved. Helman reload started.",
    config_saved: "Config saved.",
    config_saved_reload_failed: "Config was saved, but Helman reload failed.",
    save_rejected: "Save was rejected because the backend validation found errors.",
    save_failed: "Failed to save the Helman config.",
    load_ha_form_failed: "Failed to load Home Assistant form components.",
    load_ha_yaml_editor_failed: "Failed to load the Home Assistant YAML editor.",
    fix_yaml_errors_first: "Fix the YAML errors before validating or saving.",
    fix_descendant_yaml_errors: "Fix child YAML errors before switching this scope to YAML.",
    enter_yaml_failed: "Failed to open the YAML editor for this scope."
  },
  confirm: {
    discard_changes: "Discard unsaved changes and reload the stored config?"
  },
  rename: {
    target_not_available: "Target object is not available.",
    key_empty: "Key must not be empty.",
    key_exists: "Key {key} already exists.",
    key_missing: "Key {key} does not exist."
  },
  values: {
    fixed_max_power: "Fixed max power",
    surplus_aware: "Surplus aware",
    unknown: "unknown",
    missing_id: "missing id"
  },
  mode: {
    visual: "Visual",
    yaml: "YAML"
  },
  yaml: {
    field_label: "YAML",
    aria_label: "YAML editor for {scope}",
    helpers: {
      document: "Editing the full config document as YAML.",
      tab: "Editing only the current tab branch as YAML.",
      section: "Editing only this section branch as YAML."
    },
    errors: {
      fix_before_leaving: "Fix the YAML errors before switching back to visual mode.",
      parse_failed: "YAML syntax is invalid for this scope.",
      non_json_value: "YAML for this scope must resolve to JSON-compatible values only.",
      expected_object: "YAML for this scope must be an object.",
      expected_array: "YAML for this scope must be a list.",
      unexpected_key: "YAML key {key} is not supported in this scope.",
      apply_failed: "Failed to apply the YAML changes to this scope."
    }
  },
  dynamic: {
    consumer: "Consumer {index}",
    daily_energy_entity: "Daily energy entity {index}",
    import_window: "Import window {index}",
    appliance: "Appliance {index}",
    ev_charger: "EV Charger {index}",
    vehicle: "Vehicle {index}",
    unsupported_appliance_kind: "Unsupported appliance kind: {kind}"
  }
}, Qt = {
  editor: it
}, Xt = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: Qt,
  editor: it
}, Symbol.toStringTag, { value: "Module" })), ae = {
  cs: Zt,
  en: Xt
};
function Fe(s) {
  var t;
  const e = ti((s == null ? void 0 : s.language) || ((t = s == null ? void 0 : s.locale) == null ? void 0 : t.language) || "cs");
  return (i) => ei(i, e);
}
function ei(s, e = "cs") {
  const t = e.replace(/['"]+/g, "").replace("_", "-");
  let i;
  try {
    i = s.split(".").reduce((r, o) => r[o], ae[t]);
  } catch {
    try {
      i = s.split(".").reduce((o, a) => o[a], ae.cs);
    } catch {
      i = s;
    }
  }
  if (i === void 0)
    try {
      i = s.split(".").reduce((r, o) => r[o], ae.cs);
    } catch {
      i = s;
    }
  return i;
}
function ti(s) {
  return s ? s.substring(0, 2) : "cs";
}
const ze = ["ha-entity-picker", "ha-formfield", "ha-switch"], De = "ha-yaml-editor";
let I = null, U = null;
const ii = async () => {
  if (!ze.every((s) => customElements.get(s))) {
    if (I)
      return I;
    I = (async () => {
      await customElements.whenDefined("partial-panel-resolver");
      const s = document.createElement(
        "partial-panel-resolver"
      );
      s.hass = {
        panels: [
          {
            url_path: "tmp",
            component_name: "config"
          }
        ]
      }, s._updateRoutes(), await s.routerOptions.routes.tmp.load(), await customElements.whenDefined("ha-panel-config"), await document.createElement("ha-panel-config").routerOptions.routes.automation.load(), await Promise.all(ze.map((t) => customElements.whenDefined(t)));
    })();
    try {
      await I;
    } catch (s) {
      throw I = null, s;
    }
  }
}, ri = async () => {
  if (!customElements.get(De)) {
    if (U)
      return U;
    U = (async () => {
      var i, r, o, a, d, n, c;
      await customElements.whenDefined("partial-panel-resolver"), await ((o = (r = (i = document.createElement(
        "partial-panel-resolver"
      ).getRoutes([
        {
          component_name: "developer-tools",
          url_path: "tmp"
        }
      ]).routes) == null ? void 0 : i.tmp) == null ? void 0 : r.load) == null ? void 0 : o.call(r)), await customElements.whenDefined("developer-tools-router"), await ((c = (n = (d = (a = document.createElement(
        "developer-tools-router"
      ).routerOptions) == null ? void 0 : a.routes) == null ? void 0 : d.service) == null ? void 0 : n.load) == null ? void 0 : c.call(n)), await customElements.whenDefined(De);
    })();
    try {
      await U;
    } catch (s) {
      throw U = null, s;
    }
  }
}, ne = "YAML must resolve to JSON-compatible scalars, arrays, and objects.";
function si(s) {
  try {
    return {
      ok: !0,
      value: ce(s)
    };
  } catch {
    return { ok: !1, code: "non_json_value" };
  }
}
function ce(s) {
  if (s === null)
    return null;
  if (typeof s == "string" || typeof s == "boolean")
    return s;
  if (typeof s == "number") {
    if (!Number.isFinite(s))
      throw new Error(ne);
    return s;
  }
  if (Array.isArray(s))
    return s.map((e) => ce(e));
  if (typeof s == "object") {
    const e = Object.getPrototypeOf(s);
    if (e !== Object.prototype && e !== null)
      throw new Error(ne);
    const t = {};
    for (const [i, r] of Object.entries(s))
      t[i] = ce(r);
    return t;
  }
  throw new Error(ne);
}
const oi = [
  { value: "fixed_max_power", labelKey: "editor.values.fixed_max_power" },
  { value: "surplus_aware", labelKey: "editor.values.surplus_aware" }
], ee = class ee extends B {
  constructor() {
    super(...arguments), this._fallbackLocalize = Fe(), this._activeTab = "general", this._config = null, this._dirty = !1, this._loading = !1, this._saving = !1, this._validating = !1, this._validation = null, this._message = null, this._hasLoadedOnce = !1, this._scopeModes = {}, this._scopeYamlValues = {}, this._scopeYamlErrors = {}, this._preventSummaryToggle = (e) => {
      e.preventDefault(), e.stopPropagation();
    }, this._handleReloadClick = async () => {
      (this._dirty || this._hasBlockingYamlErrors()) && !window.confirm(this._t("editor.confirm.discard_changes")) || await this._loadConfig({ showMessage: !0 });
    }, this._handleValidateClick = async () => {
      await this._validateConfig();
    }, this._handleSaveClick = async () => {
      await this._saveConfig();
    }, this._handleAddDeviceLabelCategory = () => {
      const e = E(this._getValue(["device_label_text"])).map(
        ([i]) => i
      ), t = Pt(e);
      this._applyMutation((i) => {
        m(i, ["device_label_text", t], {});
      });
    }, this._handleAddDeferrableConsumer = () => {
      var t;
      const e = ((t = A(
        this._getValue(["power_devices", "house", "forecast", "deferrable_consumers"])
      )) == null ? void 0 : t.length) ?? 0;
      this._applyMutation((i) => {
        z(
          i,
          ["power_devices", "house", "forecast", "deferrable_consumers"],
          Nt(
            this._tFormat("editor.dynamic.consumer", { index: e + 1 })
          )
        );
      });
    }, this._handleAddDailyEnergyEntity = () => {
      this._applyMutation((e) => {
        z(
          e,
          ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
          zt()
        );
      });
    }, this._handleAddImportPriceWindow = () => {
      this._applyMutation((e) => {
        z(
          e,
          ["power_devices", "grid", "forecast", "import_price_windows"],
          Ft()
        );
      });
    }, this._handleAddAppliance = () => {
      const e = (A(this._getValue(["appliances"])) ?? []).map((t) => {
        var i;
        return this._stringValue((i = f(t)) == null ? void 0 : i.id);
      }).filter((t) => t.length > 0);
      this._applyMutation((t) => {
        z(
          t,
          ["appliances"],
          Lt(
            e,
            this._tFormat("editor.dynamic.ev_charger", { index: e.length + 1 }),
            this._tFormat("editor.dynamic.vehicle", { index: 1 })
          )
        );
      });
    };
  }
  get hass() {
    return this._hass;
  }
  set hass(e) {
    const t = this._hass;
    this._hass = e, e && !this._localize && (this._localize = Fe(e)), this.requestUpdate("hass", t);
  }
  connectedCallback() {
    super.connectedCallback(), ii().then(() => {
      this.requestUpdate();
    }).catch((e) => {
      this._message = {
        kind: "error",
        text: this._formatError(
          e,
          this._t("editor.messages.load_ha_form_failed")
        )
      };
    });
  }
  updated(e) {
    super.updated(e), !this._hasLoadedOnce && this.hass && (this._hasLoadedOnce = !0, this._loadConfig({ showMessage: !1 }));
  }
  render() {
    var i;
    const e = this._buildTabIssueCounts(), t = this._hasBlockingYamlErrors();
    return l`
      <div class="page">
        <div class="header">
          <div class="title-block">
            <h1>${this._t("editor.title")}</h1>
            <p>
              ${this._t("editor.description")}
            </p>
          </div>
          <div class="actions">
            ${this._renderModeToggle($)}
            <button
              type="button"
              ?disabled=${this._loading || this._saving || this._validating}
              @click=${this._handleReloadClick}
            >
              ${this._t("editor.actions.reload_config")}
            </button>
            <button
              type="button"
              ?disabled=${this._loading || this._saving || this._validating || !this._config || t}
              @click=${this._handleValidateClick}
            >
              ${this._validating ? this._t("editor.actions.validating") : this._t("editor.actions.validate")}
            </button>
            <button
              type="button"
              class="primary"
              ?disabled=${this._loading || this._saving || this._validating || !this._config || t}
              @click=${this._handleSaveClick}
            >
              ${this._saving ? this._t("editor.actions.saving") : this._t("editor.actions.save_and_reload")}
            </button>
          </div>
        </div>

        <div class="status-row">
          ${this._loading ? l`<span class="badge info">${this._t("editor.status.loading_config")}</span>` : h}
          ${this._dirty ? l`<span class="badge info">${this._t("editor.status.unsaved_changes")}</span>` : l`<span class="badge info">${this._t("editor.status.stored_config_loaded")}</span>`}
          ${!this._dirty && ((i = this._validation) != null && i.valid) ? l`<span class="badge info">${this._t("editor.status.last_validation_passed")}</span>` : h}
          ${this._dirty ? l`<span class="badge info">${this._t("editor.status.validation_stale")}</span>` : h}
          ${t ? l`<span class="badge info">${this._t("editor.status.fix_yaml_errors")}</span>` : h}
        </div>

        ${this._message ? l`<div class="message ${this._message.kind}">${this._message.text}</div>` : h}

        ${this._renderIssueBoard()}

        ${this._config ? this._renderDocumentBody(e) : h}
      </div>
    `;
  }
  _renderDocumentBody(e) {
    return this._isScopeYaml($) ? l`<div class="list-card">${this._renderYamlEditor($)}</div>` : l`
      <div class="tabs">
        ${Kt.map((t) => {
      const i = e[t.id];
      return l`
            <button
              type="button"
              class=${this._activeTab === t.id ? "active" : ""}
              @click=${() => {
        this._activeTab = t.id;
      }}
            >
              <span>${this._t(t.labelKey)}</span>
              ${i.errors > 0 ? l`<span class="tab-count errors">${i.errors}</span>` : i.warnings > 0 ? l`<span class="tab-count warnings">${i.warnings}</span>` : h}
            </button>
          `;
    })}
      </div>

      ${Mt(this._renderActiveTab())}
    `;
  }
  _renderActiveTab() {
    switch (this._activeTab) {
      case "general":
        return this._renderTabScope(g.general, this._renderGeneralTab());
      case "power_devices":
        return this._renderTabScope(
          g.power_devices,
          this._renderPowerDevicesTab()
        );
      case "scheduler":
        return this._renderTabScope(g.scheduler, this._renderSchedulerTab());
      case "appliances":
        return this._renderTabScope(
          g.appliances,
          this._renderAppliancesTab()
        );
      default:
        return l``;
    }
  }
  _renderTabScope(e, t) {
    return l`
      <div class="tab-scope">
        <div class="scope-toolbar">
          ${this._renderModeToggle(e)}
        </div>
        ${this._isScopeYaml(e) ? l`<div class="list-card">${this._renderYamlEditor(e)}</div>` : l`<div class="tab-body">${t}</div>`}
      </div>
    `;
  }
  _renderSectionScope(e, t) {
    const i = D(e);
    return l`
      <details class="section-card" open>
        <summary>
          <div class="section-summary-row">
            <span class="section-summary-label">${this._t(i.labelKey)}</span>
            ${this._renderModeToggle(e, { inSummary: !0 })}
          </div>
        </summary>
        <div class="section-content">
          ${this._isScopeYaml(e) ? this._renderYamlEditor(e) : t}
        </div>
      </details>
    `;
  }
  _renderModeToggle(e, t = {}) {
    const i = this._getScopeMode(e);
    return l`
      <div
        class="mode-toggle"
        @click=${t.inSummary ? this._preventSummaryToggle : void 0}
      >
        <button
          type="button"
          class=${i === "visual" ? "active" : ""}
          aria-pressed=${i === "visual"}
          @click=${(r) => this._handleScopeModeSelection(e, "visual", r)}
        >
          ${this._t("editor.mode.visual")}
        </button>
        <button
          type="button"
          class=${i === "yaml" ? "active" : ""}
          aria-pressed=${i === "yaml"}
          @click=${(r) => this._handleScopeModeSelection(e, "yaml", r)}
        >
          ${this._t("editor.mode.yaml")}
        </button>
      </div>
    `;
  }
  _renderYamlEditor(e) {
    const t = D(e), i = this._t(t.labelKey), r = t.kind === "document" ? "editor.yaml.helpers.document" : t.kind === "tab" ? "editor.yaml.helpers.tab" : "editor.yaml.helpers.section", o = this._scopeYamlErrors[e], a = this._scopeDomId(e), d = `${a}-yaml-helper`, n = `${a}-yaml-error`, c = o ? `${d} ${n}` : d, _ = this._scopeYamlValues[e] ?? t.adapter.read(this._config ?? {});
    return l`
      <div class="yaml-surface">
        <div
          class=${[
      "field",
      "yaml-field",
      t.kind === "document" ? "yaml-field--document" : ""
    ].filter((p) => p.length > 0).join(" ")}
        >
          <label>${this._t("editor.yaml.field_label")}</label>
          <div id=${d} class="helper">${this._t(r)}</div>
          <ha-yaml-editor
            .hass=${this.hass}
            .defaultValue=${_}
            .showErrors=${!1}
            aria-label=${this._tFormat("editor.yaml.aria_label", { scope: i })}
            aria-describedby=${c}
            dir="ltr"
            @value-changed=${(p) => this._handleYamlValueChanged(e, p)}
          ></ha-yaml-editor>
        </div>
        ${o ? l`
              <div id=${n} class="message error yaml-error">
                <div>${o}</div>
                <div class="helper">${this._t("editor.yaml.errors.fix_before_leaving")}</div>
              </div>
            ` : h}
      </div>
    `;
  }
  _renderGeneralTab() {
    return l`
      ${this._renderSectionScope(
      u.general.core_labels_and_history,
      l`
          <div class="field-grid">
            ${this._renderOptionalNumberField(
        ["history_buckets"],
        "editor.fields.history_buckets",
        "editor.helpers.history_buckets"
      )}
            ${this._renderOptionalNumberField(
        ["history_bucket_duration"],
        "editor.fields.history_bucket_duration",
        "editor.helpers.history_bucket_duration"
      )}
            ${this._renderOptionalTextField(["sources_title"], "editor.fields.sources_title")}
            ${this._renderOptionalTextField(["consumers_title"], "editor.fields.consumers_title")}
            ${this._renderOptionalTextField(["groups_title"], "editor.fields.groups_title")}
            ${this._renderOptionalTextField(["others_group_label"], "editor.fields.others_group_label")}
            ${this._renderOptionalTextField(
        ["power_sensor_name_cleaner_regex"],
        "editor.fields.power_sensor_name_cleaner_regex",
        "editor.helpers.power_sensor_name_cleaner_regex"
      )}
            ${this._renderBooleanField(
        ["show_empty_groups"],
        "editor.fields.show_empty_groups",
        !1
      )}
            ${this._renderBooleanField(
        ["show_others_group"],
        "editor.fields.show_others_group",
        !0
      )}
          </div>
        `
    )}

      ${this._renderSectionScope(
      u.general.device_label_text,
      l`
          <p class="inline-note">
            ${this._t("editor.notes.device_label_text")}
          </p>
          <div class="list-stack">
            ${this._renderDeviceLabelCategories()}
          </div>
          <div class="section-footer">
            <button type="button" class="add-button" @click=${this._handleAddDeviceLabelCategory}>
              ${this._t("editor.actions.add_category")}
            </button>
          </div>
        `
    )}
    `;
  }
  _renderPowerDevicesTab() {
    const e = A(this._getValue(["power_devices", "solar", "forecast", "daily_energy_entity_ids"])) ?? [], t = A(
      this._getValue(["power_devices", "house", "forecast", "deferrable_consumers"])
    ) ?? [], i = A(this._getValue(["power_devices", "grid", "forecast", "import_price_windows"])) ?? [];
    return l`
      ${this._renderSectionScope(
      u.power_devices.house,
      l`
          <div class="field-grid">
            ${this._renderRequiredEntityField(
        ["power_devices", "house", "entities", "power"],
        "editor.fields.house_power_entity",
        ["sensor"]
      )}
            ${this._renderOptionalTextField(
        ["power_devices", "house", "power_sensor_label"],
        "editor.fields.power_sensor_label"
      )}
            ${this._renderOptionalTextField(
        ["power_devices", "house", "power_switch_label"],
        "editor.fields.power_switch_label"
      )}
            ${this._renderOptionalTextField(
        ["power_devices", "house", "unmeasured_power_title"],
        "editor.fields.unmeasured_power_title"
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "house", "forecast", "total_energy_entity_id"],
        "editor.fields.forecast_total_energy_entity",
        ["sensor"]
      )}
            ${this._renderOptionalNumberField(
        ["power_devices", "house", "forecast", "min_history_days"],
        "editor.fields.min_history_days"
      )}
            ${this._renderOptionalNumberField(
        ["power_devices", "house", "forecast", "training_window_days"],
        "editor.fields.training_window_days"
      )}
          </div>

          <div class="list-stack">
            ${t.map(
        (r, o) => this._renderDeferrableConsumer(r, o, t.length)
      )}
          </div>
          <div class="section-footer">
            <button type="button" class="add-button" @click=${this._handleAddDeferrableConsumer}>
              ${this._t("editor.actions.add_deferrable_consumer")}
            </button>
          </div>
        `
    )}

      ${this._renderSectionScope(
      u.power_devices.solar,
      l`
          <div class="field-grid field-grid--roomy">
            ${this._renderOptionalEntityField(
        ["power_devices", "solar", "entities", "power"],
        "editor.fields.power_entity",
        ["sensor"]
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "solar", "entities", "today_energy"],
        "editor.fields.today_energy_entity",
        ["sensor"]
      )}
            ${this._renderOptionalEntityField(
        [
          "power_devices",
          "solar",
          "entities",
          "remaining_today_energy_forecast"
        ],
        "editor.fields.remaining_today_energy_forecast",
        ["sensor"]
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "solar", "forecast", "total_energy_entity_id"],
        "editor.fields.forecast_total_energy_entity",
        ["sensor"]
      )}
          </div>

          <div class="list-stack">
            ${e.map(
        (r, o) => this._renderDailyEnergyEntity(r, o, e.length)
      )}
          </div>
          <div class="section-footer">
            <button type="button" class="add-button" @click=${this._handleAddDailyEnergyEntity}>
              ${this._t("editor.actions.add_daily_energy_entity")}
            </button>
          </div>
        `
    )}

      ${this._renderSectionScope(
      u.power_devices.battery,
      l`
          <p class="inline-note">
            ${this._t("editor.notes.battery_entities")}
          </p>
          <div class="field-grid field-grid--roomy">
            ${this._renderOptionalEntityField(
        ["power_devices", "battery", "entities", "power"],
        "editor.fields.power_entity",
        ["sensor"]
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "battery", "entities", "remaining_energy"],
        "editor.fields.remaining_energy_entity",
        ["sensor"]
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "battery", "entities", "capacity"],
        "editor.fields.capacity_entity",
        ["sensor"]
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "battery", "entities", "min_soc"],
        "editor.fields.min_soc_entity",
        ["sensor"]
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "battery", "entities", "max_soc"],
        "editor.fields.max_soc_entity",
        ["sensor"]
      )}
          </div>
          <div class="field-grid">
            ${this._renderOptionalNumberField(
        ["power_devices", "battery", "forecast", "charge_efficiency"],
        "editor.fields.charge_efficiency"
      )}
            ${this._renderOptionalNumberField(
        ["power_devices", "battery", "forecast", "discharge_efficiency"],
        "editor.fields.discharge_efficiency"
      )}
            ${this._renderOptionalNumberField(
        ["power_devices", "battery", "forecast", "max_charge_power_w"],
        "editor.fields.max_charge_power_w"
      )}
            ${this._renderOptionalNumberField(
        ["power_devices", "battery", "forecast", "max_discharge_power_w"],
        "editor.fields.max_discharge_power_w"
      )}
          </div>
        `
    )}

      ${this._renderSectionScope(
      u.power_devices.grid,
      l`
          <div class="field-grid">
            ${this._renderOptionalEntityField(
        ["power_devices", "grid", "entities", "power"],
        "editor.fields.power_entity",
        ["sensor"]
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "grid", "forecast", "sell_price_entity_id"],
        "editor.fields.sell_price_entity",
        ["sensor"]
      )}
            ${this._renderOptionalTextField(
        ["power_devices", "grid", "forecast", "import_price_unit"],
        "editor.fields.import_price_unit",
        "editor.helpers.import_price_unit"
      )}
          </div>

          <p class="inline-note">
            ${this._t("editor.notes.grid_import_windows")}
          </p>
          <div class="list-stack">
            ${i.map(
        (r, o) => this._renderImportPriceWindow(r, o, i.length)
      )}
          </div>
          <div class="section-footer">
            <button type="button" class="add-button" @click=${this._handleAddImportPriceWindow}>
              ${this._t("editor.actions.add_import_price_window")}
            </button>
          </div>
        `
    )}
    `;
  }
  _renderSchedulerTab() {
    return l`
      ${this._renderSectionScope(
      u.scheduler.schedule_control_mapping,
      l`
          <div class="field-grid">
            ${this._renderRequiredEntityField(
        ["scheduler", "control", "mode_entity_id"],
        "editor.fields.mode_entity",
        ["input_select", "select"],
        "editor.helpers.mode_entity"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "normal"],
        "editor.fields.normal_option"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "charge_to_target_soc"],
        "editor.fields.charge_to_target_soc_option"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "discharge_to_target_soc"],
        "editor.fields.discharge_to_target_soc_option"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "stop_charging"],
        "editor.fields.stop_charging_option"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "stop_discharging"],
        "editor.fields.stop_discharging_option"
      )}
          </div>
        `
    )}
    `;
  }
  _renderAppliancesTab() {
    const e = A(this._getValue(["appliances"])) ?? [];
    return l`
      ${this._renderSectionScope(
      u.appliances.configured_appliances,
      l`
          <p class="inline-note">
            ${this._t("editor.notes.appliances")}
          </p>
          <div class="list-stack">
            ${e.length === 0 ? l`<div class="message info">${this._t("editor.empty.no_appliances")}</div>` : e.map(
        (t, i) => this._renderApplianceCard(t, i, e.length)
      )}
          </div>
          <div class="section-footer">
            <button type="button" class="add-button primary" @click=${this._handleAddAppliance}>
              ${this._t("editor.actions.add_ev_charger")}
            </button>
          </div>
        `
    )}
    `;
  }
  _renderDeviceLabelCategories() {
    const e = E(this._getValue(["device_label_text"]));
    return e.length === 0 ? [l`<div class="message info">${this._t("editor.empty.no_device_label_categories")}</div>`] : e.map(([t, i]) => {
      const r = E(i);
      return l`
        <div class="list-card">
          <div class="card-header">
            <div class="card-title">
              <strong>${t}</strong>
              <span class="card-subtitle">${this._t("editor.card.category")}</span>
            </div>
            <div class="inline-actions">
              <button
                type="button"
                class="danger"
                @click=${() => this._removePath(["device_label_text", t])}
              >
                ${this._t("editor.actions.remove_category")}
              </button>
            </div>
          </div>
          <div class="field-grid">
            <div class="field">
              <label>${this._t("editor.fields.category_key")}</label>
              <input
                .value=${t}
                @change=${(o) => {
        this._handleRenameObjectKey(
          ["device_label_text"],
          t,
          o.currentTarget.value
        );
      }}
              />
            </div>
          </div>
          <div class="list-stack">
            ${r.map(([o, a]) => l`
              <div class="nested-card">
                <div class="card-header">
                  <div class="card-title">
                    <strong>${o}</strong>
                    <span class="card-subtitle">${this._t("editor.card.badge_text_entry")}</span>
                  </div>
                  <div class="inline-actions">
                    <button
                      type="button"
                      class="danger"
                      @click=${() => this._removePath(["device_label_text", t, o])}
                    >
                      ${this._t("editor.actions.remove")}
                    </button>
                  </div>
                </div>
                <div class="field-grid">
                  <div class="field">
                    <label>${this._t("editor.fields.label_key")}</label>
                    <input
                      .value=${o}
                      @change=${(d) => {
        this._handleRenameObjectKey(
          ["device_label_text", t],
          o,
          d.currentTarget.value
        );
      }}
                    />
                  </div>
                  <div class="field">
                    <label>${this._t("editor.fields.badge_text")}</label>
                    <input
                      .value=${this._stringValue(a)}
                      @change=${(d) => {
        this._setRequiredString(
          ["device_label_text", t, o],
          d.currentTarget.value
        );
      }}
                    />
                  </div>
                </div>
              </div>
            `)}
          </div>
          <div class="section-footer">
            <button
              type="button"
              class="add-button"
              @click=${() => this._handleAddDeviceLabel(t)}
            >
              ${this._t("editor.actions.add_badge_text")}
            </button>
          </div>
        </div>
      `;
    });
  }
  _renderDeferrableConsumer(e, t, i) {
    const r = f(e) ?? {}, o = [
      "power_devices",
      "house",
      "forecast",
      "deferrable_consumers",
      t
    ];
    return l`
      <div class="list-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${this._stringValue(r.label) || this._tFormat("editor.dynamic.consumer", { index: t + 1 })}</strong>
            <span class="card-subtitle">${this._t("editor.card.house_deferrable_consumer")}</span>
          </div>
          <div class="list-actions">
            <button
              type="button"
              ?disabled=${t === 0}
              @click=${() => this._moveListItem(
      ["power_devices", "house", "forecast", "deferrable_consumers"],
      t,
      t - 1
    )}
            >
              ${this._t("editor.actions.up")}
            </button>
            <button
              type="button"
              ?disabled=${t === i - 1}
              @click=${() => this._moveListItem(
      ["power_devices", "house", "forecast", "deferrable_consumers"],
      t,
      t + 1
    )}
            >
              ${this._t("editor.actions.down")}
            </button>
            <button
              type="button"
              class="danger"
              @click=${() => this._removeListItem(
      ["power_devices", "house", "forecast", "deferrable_consumers"],
      t
    )}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <div class="field-grid">
          ${this._renderRequiredEntityField(
      [...o, "energy_entity_id"],
      "editor.fields.energy_entity",
      ["sensor"]
    )}
          ${this._renderOptionalTextField([...o, "label"], "editor.fields.label")}
        </div>
      </div>
    `;
  }
  _renderDailyEnergyEntity(e, t, i) {
    const r = [
      "power_devices",
      "solar",
      "forecast",
      "daily_energy_entity_ids",
      t
    ];
    return l`
      <div class="list-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${this._tFormat("editor.dynamic.daily_energy_entity", { index: t + 1 })}</strong>
          </div>
          <div class="list-actions">
            <button
              type="button"
              ?disabled=${t === 0}
              @click=${() => this._moveListItem(
      ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
      t,
      t - 1
    )}
            >
              ${this._t("editor.actions.up")}
            </button>
            <button
              type="button"
              ?disabled=${t === i - 1}
              @click=${() => this._moveListItem(
      ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
      t,
      t + 1
    )}
            >
              ${this._t("editor.actions.down")}
            </button>
            <button
              type="button"
              class="danger"
              @click=${() => this._removeListItem(
      ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
      t
    )}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        ${this._renderRequiredEntityField(r, "editor.fields.entity_id", ["sensor"], void 0, e)}
      </div>
    `;
  }
  _renderImportPriceWindow(e, t, i) {
    const r = f(e) ?? {}, o = [
      "power_devices",
      "grid",
      "forecast",
      "import_price_windows",
      t
    ];
    return l`
      <div class="list-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${this._tFormat("editor.dynamic.import_window", { index: t + 1 })}</strong>
            <span class="card-subtitle">${this._t("editor.card.local_time_window")}</span>
          </div>
          <div class="list-actions">
            <button
              type="button"
              ?disabled=${t === 0}
              @click=${() => this._moveListItem(
      ["power_devices", "grid", "forecast", "import_price_windows"],
      t,
      t - 1
    )}
            >
              ${this._t("editor.actions.up")}
            </button>
            <button
              type="button"
              ?disabled=${t === i - 1}
              @click=${() => this._moveListItem(
      ["power_devices", "grid", "forecast", "import_price_windows"],
      t,
      t + 1
    )}
            >
              ${this._t("editor.actions.down")}
            </button>
            <button
              type="button"
              class="danger"
              @click=${() => this._removeListItem(
      ["power_devices", "grid", "forecast", "import_price_windows"],
      t
    )}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <div class="field-grid">
          <div class="field">
            <label>${this._t("editor.fields.start")}</label>
            <input
              type="time"
              .value=${this._stringValue(r.start)}
              @change=${(a) => this._setRequiredString(
      [...o, "start"],
      a.currentTarget.value
    )}
            />
          </div>
          <div class="field">
            <label>${this._t("editor.fields.end")}</label>
            <input
              type="time"
              .value=${this._stringValue(r.end)}
              @change=${(a) => this._setRequiredString(
      [...o, "end"],
      a.currentTarget.value
    )}
            />
          </div>
          ${this._renderRequiredNumberField([...o, "price"], "editor.fields.price")}
        </div>
      </div>
    `;
  }
  _renderApplianceCard(e, t, i) {
    const r = f(e) ?? {};
    return this._stringValue(r.kind) !== "ev_charger" ? this._renderUnsupportedAppliance(r, t, i) : this._renderEvChargerAppliance(r, t, i);
  }
  _renderUnsupportedAppliance(e, t, i) {
    return l`
      <div class="list-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${this._stringValue(e.name) || this._tFormat("editor.dynamic.appliance", { index: t + 1 })}</strong>
            <span class="card-subtitle">
              ${this._tFormat("editor.dynamic.unsupported_appliance_kind", {
      kind: this._stringValue(e.kind) || this._t("editor.values.unknown")
    })}
            </span>
          </div>
          <div class="list-actions">
            <button
              type="button"
              ?disabled=${t === 0}
              @click=${() => this._moveListItem(["appliances"], t, t - 1)}
            >
              ${this._t("editor.actions.up")}
            </button>
            <button
              type="button"
              ?disabled=${t === i - 1}
              @click=${() => this._moveListItem(["appliances"], t, t + 1)}
            >
              ${this._t("editor.actions.down")}
            </button>
            <button
              type="button"
              class="danger"
              @click=${() => this._removeListItem(["appliances"], t)}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <pre class="raw-preview">${JSON.stringify(e, null, 2)}</pre>
      </div>
    `;
  }
  _renderEvChargerAppliance(e, t, i) {
    const r = ["appliances", t], o = E(
      this._getValue([...r, "controls", "use_mode", "values"])
    ), a = E(
      this._getValue([...r, "controls", "eco_gear", "values"])
    ), d = A(this._getValue([...r, "vehicles"])) ?? [], n = this._stringValue(e.name) || this._tFormat("editor.dynamic.ev_charger", { index: t + 1 }), c = this._stringValue(e.id) || this._t("editor.values.missing_id");
    return l`
      <div class="list-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${n}</strong>
            <span class="card-subtitle">${c}</span>
          </div>
          <div class="list-actions">
            <button
              type="button"
              ?disabled=${t === 0}
              @click=${() => this._moveListItem(["appliances"], t, t - 1)}
            >
              ${this._t("editor.actions.up")}
            </button>
            <button
              type="button"
              ?disabled=${t === i - 1}
              @click=${() => this._moveListItem(["appliances"], t, t + 1)}
            >
              ${this._t("editor.actions.down")}
            </button>
            <button
              type="button"
              class="danger"
              @click=${() => this._removeListItem(["appliances"], t)}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>

        <details class="section-card" open>
          <summary>${this._t("editor.sections.identity_and_limits")}</summary>
          <div class="section-content">
            <div class="field-grid">
              ${this._renderRequiredTextField([...r, "id"], "editor.fields.appliance_id")}
              ${this._renderRequiredTextField([...r, "name"], "editor.fields.appliance_name")}
              <div class="field">
                <label>${this._t("editor.fields.kind")}</label>
                <input value="ev_charger" disabled />
              </div>
              ${this._renderRequiredNumberField(
      [...r, "limits", "max_charging_power_kw"],
      "editor.fields.max_charging_power_kw"
    )}
            </div>
          </div>
        </details>

        <details class="section-card" open>
          <summary>${this._t("editor.sections.controls")}</summary>
          <div class="section-content">
            <div class="field-grid">
              ${this._renderRequiredEntityField(
      [...r, "controls", "charge", "entity_id"],
      "editor.fields.charge_switch_entity",
      ["switch"]
    )}
              ${this._renderRequiredEntityField(
      [...r, "controls", "use_mode", "entity_id"],
      "editor.fields.use_mode_entity",
      ["input_select", "select"]
    )}
              ${this._renderRequiredEntityField(
      [...r, "controls", "eco_gear", "entity_id"],
      "editor.fields.eco_gear_entity",
      ["input_select", "select"]
    )}
            </div>
          </div>
        </details>

        <details class="section-card" open>
          <summary>${this._t("editor.sections.use_modes")}</summary>
          <div class="section-content">
            <div class="list-stack">
              ${o.map(
      ([_, p]) => this._renderUseMode(r, _, p)
    )}
            </div>
            <div class="section-footer">
              <button
                type="button"
                class="add-button"
                @click=${() => this._handleAddUseMode(t)}
              >
                ${this._t("editor.actions.add_use_mode")}
              </button>
            </div>
          </div>
        </details>

        <details class="section-card" open>
          <summary>${this._t("editor.sections.eco_gears")}</summary>
          <div class="section-content">
            <div class="list-stack">
              ${a.map(
      ([_, p]) => this._renderEcoGear(r, _, p)
    )}
            </div>
            <div class="section-footer">
              <button
                type="button"
                class="add-button"
                @click=${() => this._handleAddEcoGear(t)}
              >
                ${this._t("editor.actions.add_eco_gear")}
              </button>
            </div>
          </div>
        </details>

        <details class="section-card" open>
          <summary>${this._t("editor.sections.vehicles")}</summary>
          <div class="section-content">
            <div class="list-stack">
              ${d.map(
      (_, p) => this._renderVehicle(r, _, p, d.length)
    )}
            </div>
            <div class="section-footer">
              <button
                type="button"
                class="add-button"
                @click=${() => this._handleAddVehicle(t)}
              >
                ${this._t("editor.actions.add_vehicle")}
              </button>
            </div>
          </div>
        </details>
      </div>
    `;
  }
  _renderUseMode(e, t, i) {
    const r = f(i) ?? {}, o = [
      ...e,
      "controls",
      "use_mode",
      "values"
    ];
    return l`
      <div class="nested-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${t}</strong>
            <span class="card-subtitle">${this._t("editor.card.use_mode_mapping")}</span>
          </div>
          <div class="inline-actions">
            <button
              type="button"
              class="danger"
              @click=${() => this._removePath([...o, t])}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <div class="field-grid">
          <div class="field">
            <label>${this._t("editor.fields.mode_id")}</label>
            <input
              .value=${t}
              @change=${(a) => this._handleRenameObjectKey(
      o,
      t,
      a.currentTarget.value
    )}
            />
          </div>
          <div class="field">
            <label>${this._t("editor.fields.behavior")}</label>
            <select
              .value=${this._stringValue(r.behavior) || "fixed_max_power"}
              @change=${(a) => this._setRequiredString(
      [...o, t, "behavior"],
      a.currentTarget.value
    )}
            >
              ${oi.map(
      (a) => l`
                  <option value=${a.value}>${this._t(a.labelKey)}</option>
                `
    )}
            </select>
          </div>
        </div>
      </div>
    `;
  }
  _renderEcoGear(e, t, i) {
    const r = f(i) ?? {}, o = [
      ...e,
      "controls",
      "eco_gear",
      "values"
    ];
    return l`
      <div class="nested-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${t}</strong>
            <span class="card-subtitle">${this._t("editor.card.eco_gear_mapping")}</span>
          </div>
          <div class="inline-actions">
            <button
              type="button"
              class="danger"
              @click=${() => this._removePath([...o, t])}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <div class="field-grid">
          <div class="field">
            <label>${this._t("editor.fields.gear_id")}</label>
            <input
              .value=${t}
              @change=${(a) => this._handleRenameObjectKey(
      o,
      t,
      a.currentTarget.value
    )}
            />
          </div>
          ${this._renderRequiredNumberField(
      [...o, t, "min_power_kw"],
      "editor.fields.min_power_kw",
      r.min_power_kw
    )}
        </div>
      </div>
    `;
  }
  _renderVehicle(e, t, i, r) {
    const o = f(t) ?? {}, a = [...e, "vehicles", i];
    return l`
      <div class="nested-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${this._stringValue(o.name) || this._tFormat("editor.dynamic.vehicle", { index: i + 1 })}</strong>
            <span class="card-subtitle">${this._stringValue(o.id) || this._t("editor.values.missing_id")}</span>
          </div>
          <div class="list-actions">
            <button
              type="button"
              ?disabled=${i === 0}
              @click=${() => this._moveListItem([...e, "vehicles"], i, i - 1)}
            >
              ${this._t("editor.actions.up")}
            </button>
            <button
              type="button"
              ?disabled=${i === r - 1}
              @click=${() => this._moveListItem([...e, "vehicles"], i, i + 1)}
            >
              ${this._t("editor.actions.down")}
            </button>
            <button
              type="button"
              class="danger"
              @click=${() => this._removeListItem([...e, "vehicles"], i)}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <div class="field-grid">
          ${this._renderRequiredTextField([...a, "id"], "editor.fields.vehicle_id")}
          ${this._renderRequiredTextField([...a, "name"], "editor.fields.vehicle_name")}
          ${this._renderRequiredEntityField(
      [...a, "telemetry", "soc_entity_id"],
      "editor.fields.soc_entity",
      ["sensor"]
    )}
          ${this._renderOptionalEntityField(
      [...a, "telemetry", "charge_limit_entity_id"],
      "editor.fields.charge_limit_entity",
      ["number"]
    )}
          ${this._renderRequiredNumberField(
      [...a, "limits", "battery_capacity_kwh"],
      "editor.fields.battery_capacity_kwh"
    )}
          ${this._renderRequiredNumberField(
      [...a, "limits", "max_charging_power_kw"],
      "editor.fields.max_charging_power_kw"
    )}
        </div>
      </div>
    `;
  }
  _renderOptionalTextField(e, t, i) {
    return l`
      <div class="field">
        <label>${this._t(t)}</label>
        <input
          .value=${this._stringValue(this._getValue(e))}
          @change=${(r) => this._setOptionalString(e, r.currentTarget.value)}
        />
        ${i ? l`<div class="helper">${this._t(i)}</div>` : h}
      </div>
    `;
  }
  _renderRequiredTextField(e, t, i) {
    const r = i === void 0 ? this._getValue(e) : i;
    return l`
      <div class="field">
        <label>${this._t(t)}</label>
        <input
          .value=${this._stringValue(r)}
          @change=${(o) => this._setRequiredString(e, o.currentTarget.value)}
        />
      </div>
    `;
  }
  _renderOptionalNumberField(e, t, i) {
    return l`
      <div class="field">
        <label>${this._t(t)}</label>
        <input
          type="number"
          step="any"
          .value=${this._stringValue(this._getValue(e))}
          @change=${(r) => this._setOptionalNumber(e, r.currentTarget.value)}
        />
        ${i ? l`<div class="helper">${this._t(i)}</div>` : h}
      </div>
    `;
  }
  _renderRequiredNumberField(e, t, i) {
    const r = i === void 0 ? this._getValue(e) : i;
    return l`
      <div class="field">
        <label>${this._t(t)}</label>
        <input
          type="number"
          step="any"
          .value=${this._stringValue(r)}
          @change=${(o) => this._setRequiredNumber(e, o.currentTarget.value)}
        />
      </div>
    `;
  }
  _renderBooleanField(e, t, i) {
    const r = this._booleanValue(this._getValue(e), i);
    return l`
      <div class="field toggle-field">
        <ha-formfield .label=${this._t(t)}>
          <ha-switch
            .checked=${r}
            @change=${(o) => this._setBoolean(
      e,
      o.currentTarget.checked
    )}
          ></ha-switch>
        </ha-formfield>
      </div>
    `;
  }
  _renderOptionalEntityField(e, t, i, r) {
    return this._renderEntityField(
      e,
      t,
      i,
      r,
      !1,
      this._getValue(e)
    );
  }
  _renderRequiredEntityField(e, t, i, r, o) {
    return this._renderEntityField(
      e,
      t,
      i,
      r,
      !0,
      o === void 0 ? this._getValue(e) : o
    );
  }
  _renderEntityField(e, t, i, r, o, a) {
    return l`
      <div class="field">
        <label>${this._t(t)}</label>
        <ha-entity-picker
          .hass=${this.hass}
          .value=${this._stringValue(a)}
          .includeDomains=${i}
          @value-changed=${(d) => {
      var c;
      const n = ((c = d.detail) == null ? void 0 : c.value) ?? "";
      o ? this._setRequiredString(e, n) : this._setOptionalString(e, n);
    }}
        ></ha-entity-picker>
        ${r ? l`<div class="helper">${this._t(r)}</div>` : h}
      </div>
    `;
  }
  _renderIssueBoard() {
    if (!this._validation)
      return h;
    const e = [
      { title: this._t("editor.issues.errors"), items: this._validation.errors },
      { title: this._t("editor.issues.warnings"), items: this._validation.warnings }
    ].filter((t) => t.items.length > 0);
    return e.length === 0 ? h : l`
      <div class="issue-board">
        ${e.map(
      (t) => l`
            <div class="issue-group">
              <h3>${t.title}</h3>
              <ul>
                ${t.items.map(
        (i) => l`
                    <li>
                      <div class="issue-path">${i.path}</div>
                      <div>${i.message}</div>
                    </li>
                  `
      )}
              </ul>
            </div>
          `
    )}
      </div>
    `;
  }
  _buildTabIssueCounts() {
    const e = {
      general: { errors: 0, warnings: 0 },
      power_devices: { errors: 0, warnings: 0 },
      scheduler: { errors: 0, warnings: 0 },
      appliances: { errors: 0, warnings: 0 }
    };
    if (this._validation) {
      for (const t of this._validation.errors) {
        const i = Le[t.section] ?? "general";
        e[i].errors += 1;
      }
      for (const t of this._validation.warnings) {
        const i = Le[t.section] ?? "general";
        e[i].warnings += 1;
      }
    }
    for (const t of Object.keys(this._scopeYamlErrors)) {
      if (!this._scopeYamlErrors[t])
        continue;
      const i = D(t).tabId;
      i && (e[i].warnings += 1);
    }
    return e;
  }
  async _loadConfig(e) {
    if (this.hass) {
      this._loading = !0;
      try {
        const t = await this.hass.callWS({ type: "helman/get_config" });
        this._config = f(t) ? y(t) : {}, this._validation = null, this._dirty = !1, this._resetScopeYamlState(), e.showMessage && (this._message = {
          kind: "info",
          text: this._t("editor.messages.reloaded_config")
        });
      } catch (t) {
        this._message = {
          kind: "error",
          text: this._formatError(t, this._t("editor.messages.load_config_failed"))
        };
      } finally {
        this._loading = !1;
      }
    }
  }
  async _validateConfig() {
    if (!(!this.hass || !this._config)) {
      if (this._hasBlockingYamlErrors()) {
        this._message = {
          kind: "error",
          text: this._t("editor.messages.fix_yaml_errors_first")
        };
        return;
      }
      this._validating = !0;
      try {
        const e = await this.hass.callWS({
          type: "helman/validate_config",
          config: this._config
        });
        this._validation = e, this._message = e.valid ? { kind: "success", text: this._t("editor.messages.validation_passed") } : {
          kind: "error",
          text: this._t("editor.messages.validation_failed")
        };
      } catch (e) {
        this._message = {
          kind: "error",
          text: this._formatError(e, this._t("editor.messages.validate_config_failed"))
        };
      } finally {
        this._validating = !1;
      }
    }
  }
  async _saveConfig() {
    if (!(!this.hass || !this._config)) {
      if (this._hasBlockingYamlErrors()) {
        this._message = {
          kind: "error",
          text: this._t("editor.messages.fix_yaml_errors_first")
        };
        return;
      }
      this._saving = !0;
      try {
        const e = await this.hass.callWS({
          type: "helman/save_config",
          config: this._config
        });
        if (this._validation = e.validation, e.success) {
          this._dirty = !1, this._message = {
            kind: "success",
            text: e.reloadStarted ? this._t("editor.messages.config_saved_reload_started") : this._t("editor.messages.config_saved")
          };
          return;
        }
        this._message = {
          kind: "error",
          text: e.reloadError ?? (e.validation.valid ? this._t("editor.messages.config_saved_reload_failed") : this._t("editor.messages.save_rejected"))
        };
      } catch (e) {
        this._message = {
          kind: "error",
          text: this._formatError(e, this._t("editor.messages.save_failed"))
        };
      } finally {
        this._saving = !1;
      }
    }
  }
  _handleScopeModeSelection(e, t, i) {
    if (i.preventDefault(), i.stopPropagation(), t === "yaml") {
      this._enterYamlMode(e);
      return;
    }
    this._exitYamlMode(e);
  }
  async _enterYamlMode(e) {
    if (!this._config || this._isScopeYaml(e))
      return;
    if (this._hasBlockingDescendantYamlErrors(e)) {
      this._message = {
        kind: "error",
        text: this._t("editor.messages.fix_descendant_yaml_errors")
      };
      return;
    }
    const t = Ne(e);
    try {
      if (await ri(), !this._config || this._isScopeYaml(e))
        return;
      const i = this._omitScopeIds(this._scopeModes, t);
      i[e] = "yaml";
      const r = this._omitScopeIds(
        this._scopeYamlValues,
        t
      );
      r[e] = D(e).adapter.read(this._config);
      const o = this._omitScopeIds(
        this._scopeYamlErrors,
        t
      );
      delete o[e], this._scopeModes = i, this._scopeYamlValues = r, this._scopeYamlErrors = o, this._message = null;
    } catch (i) {
      this._message = {
        kind: "error",
        text: this._formatError(
          i,
          this._t("editor.messages.load_ha_yaml_editor_failed")
        )
      };
    }
  }
  _exitYamlMode(e) {
    if (!this._isScopeYaml(e) || this._scopeYamlErrors[e])
      return;
    const t = { ...this._scopeModes };
    delete t[e];
    const i = { ...this._scopeYamlValues };
    delete i[e];
    const r = { ...this._scopeYamlErrors };
    delete r[e], this._scopeModes = t, this._scopeYamlValues = i, this._scopeYamlErrors = r;
  }
  _handleYamlValueChanged(e, t) {
    if (t.stopPropagation(), !t.detail.isValid) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [e]: t.detail.errorMsg ?? this._t("editor.yaml.errors.parse_failed")
      };
      return;
    }
    const i = si(t.detail.value);
    if (!i.ok) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [e]: this._t("editor.yaml.errors.non_json_value")
      };
      return;
    }
    const r = D(e).adapter, o = r.validate(i.value);
    if (o) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [e]: this._formatScopeYamlValidationError(o)
      };
      return;
    }
    try {
      const a = y(i.value);
      this._config = r.apply(this._config ?? {}, a), this._dirty = !0, this._validation = null, this._message = null, this._scopeYamlValues = {
        ...this._scopeYamlValues,
        [e]: a
      };
      const d = { ...this._scopeYamlErrors };
      delete d[e], this._scopeYamlErrors = d;
    } catch (a) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [e]: this._formatError(a, this._t("editor.yaml.errors.apply_failed"))
      };
    }
  }
  _hasBlockingYamlErrors() {
    return Object.values(this._scopeYamlErrors).some(
      (e) => typeof e == "string" && e.length > 0
    );
  }
  _hasBlockingDescendantYamlErrors(e) {
    return Ne(e).some(
      (t) => {
        const i = this._scopeYamlErrors[t];
        return typeof i == "string" && i.length > 0;
      }
    );
  }
  _resetScopeYamlState() {
    this._scopeModes = {}, this._scopeYamlValues = {}, this._scopeYamlErrors = {};
  }
  _omitScopeIds(e, t) {
    const i = { ...e };
    for (const r of t)
      delete i[r];
    return i;
  }
  _getScopeMode(e) {
    return this._scopeModes[e] ?? "visual";
  }
  _isScopeYaml(e) {
    return this._getScopeMode(e) === "yaml";
  }
  _scopeDomId(e) {
    return e.replaceAll(":", "-").replaceAll(".", "-");
  }
  _handleAddDeviceLabel(e) {
    const t = E(this._getValue(["device_label_text", e])).map(
      ([r]) => r
    ), i = Tt(t);
    this._applyMutation((r) => {
      m(r, ["device_label_text", e, i], "");
    });
  }
  _handleAddVehicle(e) {
    const t = ["appliances", e, "vehicles"], i = (A(this._getValue(t)) ?? []).map((r) => {
      var o;
      return this._stringValue((o = f(r)) == null ? void 0 : o.id);
    }).filter((r) => r.length > 0);
    this._applyMutation((r) => {
      z(
        r,
        t,
        Ze(
          i,
          this._tFormat("editor.dynamic.vehicle", { index: i.length + 1 })
        )
      );
    });
  }
  _handleAddUseMode(e) {
    const t = [
      "appliances",
      e,
      "controls",
      "use_mode",
      "values"
    ], i = Dt(E(this._getValue(t)).map(([r]) => r));
    this._applyMutation((r) => {
      m(r, [...t, i], Rt());
    });
  }
  _handleAddEcoGear(e) {
    const t = [
      "appliances",
      e,
      "controls",
      "eco_gear",
      "values"
    ], i = It(E(this._getValue(t)).map(([r]) => r));
    this._applyMutation((r) => {
      m(r, [...t, i], Yt());
    });
  }
  _handleRenameObjectKey(e, t, i) {
    const r = i.trim();
    if (!r || r === t || !this._config)
      return;
    const o = y(this._config), a = Vt(o, e, t, r);
    if (!a.ok) {
      this._message = { kind: "error", text: this._formatRenameObjectKeyError(a) };
      return;
    }
    this._config = o, this._dirty = !0, this._validation = null, this._message = null;
  }
  _moveListItem(e, t, i) {
    this._applyMutation((r) => {
      jt(r, e, t, i);
    });
  }
  _removeListItem(e, t) {
    this._applyMutation((i) => {
      Ct(i, e, t);
    });
  }
  _removePath(e) {
    this._applyMutation((t) => {
      q(t, e);
    });
  }
  _setOptionalString(e, t) {
    const i = t.trim();
    this._applyMutation((r) => {
      if (!i) {
        q(r, e);
        return;
      }
      m(r, e, i);
    });
  }
  _setRequiredString(e, t) {
    this._applyMutation((i) => {
      m(i, e, t.trim());
    });
  }
  _setOptionalNumber(e, t) {
    const i = t.trim();
    this._applyMutation((r) => {
      if (!i) {
        q(r, e);
        return;
      }
      const o = Number(i);
      m(r, e, Number.isFinite(o) ? o : i);
    });
  }
  _setRequiredNumber(e, t) {
    const i = t.trim();
    this._applyMutation((r) => {
      if (!i) {
        m(r, e, null);
        return;
      }
      const o = Number(i);
      m(r, e, Number.isFinite(o) ? o : i);
    });
  }
  _setBoolean(e, t) {
    this._applyMutation((i) => {
      m(i, e, t);
    });
  }
  _applyMutation(e) {
    const t = y(this._config ?? {});
    e(t), this._config = t, this._dirty = !0, this._validation = null, this._message = null;
  }
  _getValue(e) {
    if (this._config)
      return k(this._config, e);
  }
  _stringValue(e) {
    return typeof e == "string" ? e : typeof e == "number" ? String(e) : "";
  }
  _booleanValue(e, t) {
    return typeof e == "boolean" ? e : t;
  }
  _t(e) {
    return (this._localize ?? this._fallbackLocalize)(e);
  }
  _tFormat(e, t) {
    let i = this._t(e);
    for (const [r, o] of Object.entries(t))
      i = i.replaceAll(`{${r}}`, String(o));
    return i;
  }
  _formatScopeYamlValidationError(e) {
    switch (e.code) {
      case "expected_object":
        return this._t("editor.yaml.errors.expected_object");
      case "expected_array":
        return this._t("editor.yaml.errors.expected_array");
      case "unexpected_key":
        return this._tFormat("editor.yaml.errors.unexpected_key", {
          key: e.key ?? ""
        });
    }
  }
  _formatRenameObjectKeyError(e) {
    switch (e.reason) {
      case "target_not_available":
        return this._t("editor.rename.target_not_available");
      case "empty_key":
        return this._t("editor.rename.key_empty");
      case "duplicate_key":
        return this._tFormat("editor.rename.key_exists", {
          key: e.key ?? ""
        });
      case "missing_key":
        return this._tFormat("editor.rename.key_missing", {
          key: e.key ?? ""
        });
    }
  }
  _formatError(e, t) {
    if (typeof e == "object" && e !== null && "message" in e) {
      const i = e.message;
      if (typeof i == "string" && i)
        return i;
    }
    return t;
  }
};
ee.properties = {
  hass: { attribute: !1 },
  narrow: { type: Boolean },
  route: { attribute: !1 },
  panel: { attribute: !1 },
  _activeTab: { state: !0 },
  _config: { state: !0 },
  _dirty: { state: !0 },
  _loading: { state: !0 },
  _saving: { state: !0 },
  _validating: { state: !0 },
  _validation: { state: !0 },
  _message: { state: !0 },
  _hasLoadedOnce: { state: !0 },
  _scopeModes: { state: !0 },
  _scopeYamlValues: { state: !0 },
  _scopeYamlErrors: { state: !0 }
}, ee.styles = st`
    :host {
      display: block;
      min-height: 100%;
      background: var(--primary-background-color);
      color: var(--primary-text-color);
    }

    * {
      box-sizing: border-box;
    }

    .page {
      max-width: 1240px;
      margin: 0 auto;
      padding: 24px 20px 48px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 24px;
    }

    .title-block h1 {
      margin: 0 0 8px;
      font-size: 1.9rem;
      line-height: 1.2;
    }

    .title-block p {
      margin: 0;
      color: var(--secondary-text-color);
      max-width: 780px;
      line-height: 1.5;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      justify-content: flex-end;
    }

    .mode-toggle {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      border: 1px solid var(--divider-color);
      border-radius: 999px;
      background: var(--card-background-color);
    }

    .mode-toggle button {
      border: none;
      background: transparent;
      color: var(--secondary-text-color);
      padding: 4px 10px;
      border-radius: 999px;
      cursor: pointer;
      font: inherit;
      font-size: 0.76rem;
      font-weight: 600;
    }

    .mode-toggle button:hover {
      background: rgba(127, 127, 127, 0.08);
    }

    .mode-toggle button.active {
      background: rgba(3, 169, 244, 0.12);
      color: var(--primary-color);
    }

    .mode-toggle button.active:hover {
      background: rgba(3, 169, 244, 0.16);
    }

    .actions button,
    .inline-actions button,
    .list-actions button,
    .add-button {
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
      color: var(--primary-text-color);
      padding: 10px 14px;
      border-radius: 999px;
      cursor: pointer;
      font: inherit;
      transition: background 0.2s ease, border-color 0.2s ease;
    }

    .actions button:hover,
    .inline-actions button:hover,
    .list-actions button:hover,
    .add-button:hover {
      background: rgba(127, 127, 127, 0.08);
    }

    .actions button.primary,
    .add-button.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: var(--text-primary-color, white);
    }

    .actions button.primary:hover,
    .add-button.primary:hover {
      filter: brightness(1.03);
    }

    .actions button.danger,
    .inline-actions button.danger,
    .list-actions button.danger {
      border-color: var(--error-color);
      color: var(--error-color);
    }

    .actions button:disabled,
    .inline-actions button:disabled,
    .list-actions button:disabled,
    .add-button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .status-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      margin-bottom: 16px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 0.88rem;
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
    }

    .badge.info {
      color: var(--secondary-text-color);
    }

    .message {
      border: 1px solid var(--divider-color);
      border-radius: 16px;
      padding: 14px 16px;
      margin-bottom: 16px;
      background: var(--card-background-color);
    }

    .message.success {
      border-color: #2e7d32;
      background: rgba(46, 125, 50, 0.08);
    }

    .message.error {
      border-color: var(--error-color);
      background: rgba(244, 67, 54, 0.08);
    }

    .message.info {
      border-color: var(--primary-color);
      background: rgba(3, 169, 244, 0.08);
    }

    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 20px;
    }

    .tabs button {
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
      color: var(--primary-text-color);
      border-radius: 999px;
      padding: 10px 16px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font: inherit;
    }

    .tabs button.active {
      border-color: var(--primary-color);
      color: var(--primary-color);
      background: rgba(3, 169, 244, 0.08);
    }

    .tab-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 22px;
      border-radius: 999px;
      padding: 0 6px;
      font-size: 0.78rem;
      background: rgba(127, 127, 127, 0.18);
      color: inherit;
    }

    .tab-count.errors {
      background: rgba(244, 67, 54, 0.12);
      color: var(--error-color);
    }

    .tab-count.warnings {
      background: rgba(255, 152, 0, 0.12);
      color: #ef6c00;
    }

    .issue-board {
      display: grid;
      gap: 14px;
      margin-bottom: 20px;
    }

    .issue-group {
      border: 1px solid var(--divider-color);
      border-radius: 16px;
      padding: 16px;
      background: var(--card-background-color);
    }

    .issue-group h3 {
      margin: 0 0 10px;
      font-size: 1rem;
    }

    .issue-group ul {
      margin: 0;
      padding-left: 18px;
      display: grid;
      gap: 8px;
    }

    .issue-path {
      font-family: var(--code-font-family, monospace);
      font-size: 0.9rem;
    }

    .tab-body {
      display: grid;
      gap: 16px;
    }

    .tab-scope {
      display: grid;
      gap: 16px;
    }

    .scope-toolbar {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 12px;
    }

    details.section-card,
    .list-card,
    .nested-card {
      border: 1px solid var(--divider-color);
      border-radius: 18px;
      background: var(--card-background-color);
    }

    details.section-card {
      padding: 0 18px 18px;
    }

    details.section-card > summary {
      list-style: none;
      cursor: pointer;
      padding: 18px 0;
      font-size: 1.04rem;
      font-weight: 600;
    }

    .section-summary-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .section-summary-label {
      min-width: 0;
    }

    details.section-card > summary::-webkit-details-marker {
      display: none;
    }

    .section-content {
      display: grid;
      gap: 18px;
    }

    .field-grid {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    }

    .field-grid > * {
      min-width: 0;
    }

    .field-grid--roomy {
      grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));
    }

    .field {
      display: grid;
      gap: 8px;
      align-content: start;
      min-width: 0;
    }

    .toggle-field {
      display: block;
    }

    .toggle-field ha-formfield {
      display: block;
      width: 100%;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid var(--divider-color);
      background: var(--secondary-background-color);
      color: var(--primary-text-color);
    }

    .field label {
      font-weight: 600;
      font-size: 0.93rem;
    }

    .field input,
    .field select,
    .field textarea {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--divider-color);
      background: var(--secondary-background-color);
      color: var(--primary-text-color);
      padding: 12px 14px;
      font: inherit;
    }

    .field textarea {
      min-height: 120px;
      resize: vertical;
    }

    .yaml-surface {
      display: grid;
      gap: 12px;
    }

    .yaml-field ha-yaml-editor {
      display: block;
      --code-mirror-height: clamp(320px, 58vh, 720px);
      --code-mirror-max-height: clamp(320px, 58vh, 720px);
    }

    .yaml-field--document ha-yaml-editor {
      --code-mirror-height: clamp(420px, 72vh, 980px);
      --code-mirror-max-height: clamp(420px, 72vh, 980px);
    }

    .yaml-error {
      margin: 0;
    }

    .field ha-entity-picker {
      display: block;
      width: 100%;
      min-width: 0;
      max-width: 100%;
    }

    .helper {
      color: var(--secondary-text-color);
      font-size: 0.86rem;
      line-height: 1.4;
    }

    .list-stack {
      display: grid;
      gap: 14px;
    }

    .list-card,
    .nested-card {
      padding: 16px;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 14px;
    }

    .card-title {
      display: grid;
      gap: 4px;
    }

    .card-title strong {
      font-size: 1rem;
    }

    .card-subtitle {
      color: var(--secondary-text-color);
      font-size: 0.88rem;
    }

    .inline-actions,
    .list-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .inline-note {
      color: var(--secondary-text-color);
      font-size: 0.9rem;
    }

    pre.raw-preview {
      margin: 0;
      padding: 14px;
      border-radius: 14px;
      background: var(--secondary-background-color);
      overflow: auto;
      white-space: pre-wrap;
      font-size: 0.84rem;
      line-height: 1.45;
    }

    .section-footer {
      display: flex;
      justify-content: flex-start;
      margin-top: 4px;
    }

    @media (max-width: 900px) {
      .header {
        flex-direction: column;
      }

      .actions,
      .scope-toolbar {
        justify-content: flex-start;
      }
    }
  `;
let _e = ee;
const Ie = "helman-config-editor-panel";
customElements.get(Ie) || customElements.define(Ie, _e);
