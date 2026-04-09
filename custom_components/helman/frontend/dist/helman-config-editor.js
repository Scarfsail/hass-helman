/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const Q = globalThis, _e = Q.ShadowRoot && (Q.ShadyCSS === void 0 || Q.ShadyCSS.nativeShadow) && "adoptedStyleSheets" in Document.prototype && "replace" in CSSStyleSheet.prototype, he = Symbol(), me = /* @__PURE__ */ new WeakMap();
let Ue = class {
  constructor(e, t, i) {
    if (this._$cssResult$ = !0, i !== he) throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");
    this.cssText = e, this.t = t;
  }
  get styleSheet() {
    let e = this.o;
    const t = this.t;
    if (_e && e === void 0) {
      const i = t !== void 0 && t.length === 1;
      i && (e = me.get(t)), e === void 0 && ((this.o = e = new CSSStyleSheet()).replaceSync(this.cssText), i && me.set(t, e));
    }
    return e;
  }
  toString() {
    return this.cssText;
  }
};
const ot = (r) => new Ue(typeof r == "string" ? r : r + "", void 0, he), rt = (r, ...e) => {
  const t = r.length === 1 ? r[0] : e.reduce((i, o, a) => i + ((n) => {
    if (n._$cssResult$ === !0) return n.cssText;
    if (typeof n == "number") return n;
    throw Error("Value passed to 'css' function must be a 'css' function result: " + n + ". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.");
  })(o) + r[a + 1], r[0]);
  return new Ue(t, r, he);
}, at = (r, e) => {
  if (_e) r.adoptedStyleSheets = e.map((t) => t instanceof CSSStyleSheet ? t : t.styleSheet);
  else for (const t of e) {
    const i = document.createElement("style"), o = Q.litNonce;
    o !== void 0 && i.setAttribute("nonce", o), i.textContent = t.cssText, r.appendChild(i);
  }
}, ye = _e ? (r) => r : (r) => r instanceof CSSStyleSheet ? ((e) => {
  let t = "";
  for (const i of e.cssRules) t += i.cssText;
  return ot(t);
})(r) : r;
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const { is: nt, defineProperty: st, getOwnPropertyDescriptor: lt, getOwnPropertyNames: dt, getOwnPropertySymbols: ct, getPrototypeOf: pt } = Object, z = globalThis, ve = z.trustedTypes, _t = ve ? ve.emptyScript : "", ie = z.reactiveElementPolyfillSupport, U = (r, e) => r, le = { toAttribute(r, e) {
  switch (e) {
    case Boolean:
      r = r ? _t : null;
      break;
    case Object:
    case Array:
      r = r == null ? r : JSON.stringify(r);
  }
  return r;
}, fromAttribute(r, e) {
  let t = r;
  switch (e) {
    case Boolean:
      t = r !== null;
      break;
    case Number:
      t = r === null ? null : Number(r);
      break;
    case Object:
    case Array:
      try {
        t = JSON.parse(r);
      } catch {
        t = null;
      }
  }
  return t;
} }, We = (r, e) => !nt(r, e), be = { attribute: !0, type: String, converter: le, reflect: !1, useDefault: !1, hasChanged: We };
Symbol.metadata ?? (Symbol.metadata = Symbol("metadata")), z.litPropertyMetadata ?? (z.litPropertyMetadata = /* @__PURE__ */ new WeakMap());
let I = class extends HTMLElement {
  static addInitializer(e) {
    this._$Ei(), (this.l ?? (this.l = [])).push(e);
  }
  static get observedAttributes() {
    return this.finalize(), this._$Eh && [...this._$Eh.keys()];
  }
  static createProperty(e, t = be) {
    if (t.state && (t.attribute = !1), this._$Ei(), this.prototype.hasOwnProperty(e) && ((t = Object.create(t)).wrapped = !0), this.elementProperties.set(e, t), !t.noAccessor) {
      const i = Symbol(), o = this.getPropertyDescriptor(e, i, t);
      o !== void 0 && st(this.prototype, e, o);
    }
  }
  static getPropertyDescriptor(e, t, i) {
    const { get: o, set: a } = lt(this.prototype, e) ?? { get() {
      return this[t];
    }, set(n) {
      this[t] = n;
    } };
    return { get: o, set(n) {
      const s = o == null ? void 0 : o.call(this);
      a == null || a.call(this, n), this.requestUpdate(e, s, i);
    }, configurable: !0, enumerable: !0 };
  }
  static getPropertyOptions(e) {
    return this.elementProperties.get(e) ?? be;
  }
  static _$Ei() {
    if (this.hasOwnProperty(U("elementProperties"))) return;
    const e = pt(this);
    e.finalize(), e.l !== void 0 && (this.l = [...e.l]), this.elementProperties = new Map(e.elementProperties);
  }
  static finalize() {
    if (this.hasOwnProperty(U("finalized"))) return;
    if (this.finalized = !0, this._$Ei(), this.hasOwnProperty(U("properties"))) {
      const t = this.properties, i = [...dt(t), ...ct(t)];
      for (const o of i) this.createProperty(o, t[o]);
    }
    const e = this[Symbol.metadata];
    if (e !== null) {
      const t = litPropertyMetadata.get(e);
      if (t !== void 0) for (const [i, o] of t) this.elementProperties.set(i, o);
    }
    this._$Eh = /* @__PURE__ */ new Map();
    for (const [t, i] of this.elementProperties) {
      const o = this._$Eu(t, i);
      o !== void 0 && this._$Eh.set(o, t);
    }
    this.elementStyles = this.finalizeStyles(this.styles);
  }
  static finalizeStyles(e) {
    const t = [];
    if (Array.isArray(e)) {
      const i = new Set(e.flat(1 / 0).reverse());
      for (const o of i) t.unshift(ye(o));
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
    return at(e, this.constructor.elementStyles), e;
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
    var a;
    const i = this.constructor.elementProperties.get(e), o = this.constructor._$Eu(e, i);
    if (o !== void 0 && i.reflect === !0) {
      const n = (((a = i.converter) == null ? void 0 : a.toAttribute) !== void 0 ? i.converter : le).toAttribute(t, i.type);
      this._$Em = e, n == null ? this.removeAttribute(o) : this.setAttribute(o, n), this._$Em = null;
    }
  }
  _$AK(e, t) {
    var a, n;
    const i = this.constructor, o = i._$Eh.get(e);
    if (o !== void 0 && this._$Em !== o) {
      const s = i.getPropertyOptions(o), l = typeof s.converter == "function" ? { fromAttribute: s.converter } : ((a = s.converter) == null ? void 0 : a.fromAttribute) !== void 0 ? s.converter : le;
      this._$Em = o;
      const c = l.fromAttribute(t, s.type);
      this[o] = c ?? ((n = this._$Ej) == null ? void 0 : n.get(o)) ?? c, this._$Em = null;
    }
  }
  requestUpdate(e, t, i, o = !1, a) {
    var n;
    if (e !== void 0) {
      const s = this.constructor;
      if (o === !1 && (a = this[e]), i ?? (i = s.getPropertyOptions(e)), !((i.hasChanged ?? We)(a, t) || i.useDefault && i.reflect && a === ((n = this._$Ej) == null ? void 0 : n.get(e)) && !this.hasAttribute(s._$Eu(e, i)))) return;
      this.C(e, t, i);
    }
    this.isUpdatePending === !1 && (this._$ES = this._$EP());
  }
  C(e, t, { useDefault: i, reflect: o, wrapped: a }, n) {
    i && !(this._$Ej ?? (this._$Ej = /* @__PURE__ */ new Map())).has(e) && (this._$Ej.set(e, n ?? t ?? this[e]), a !== !0 || n !== void 0) || (this._$AL.has(e) || (this.hasUpdated || i || (t = void 0), this._$AL.set(e, t)), o === !0 && this._$Em !== e && (this._$Eq ?? (this._$Eq = /* @__PURE__ */ new Set())).add(e));
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
        for (const [a, n] of this._$Ep) this[a] = n;
        this._$Ep = void 0;
      }
      const o = this.constructor.elementProperties;
      if (o.size > 0) for (const [a, n] of o) {
        const { wrapped: s } = n, l = this[a];
        s !== !0 || this._$AL.has(a) || l === void 0 || this.C(a, void 0, n, l);
      }
    }
    let e = !1;
    const t = this._$AL;
    try {
      e = this.shouldUpdate(t), e ? (this.willUpdate(t), (i = this._$EO) == null || i.forEach((o) => {
        var a;
        return (a = o.hostUpdate) == null ? void 0 : a.call(o);
      }), this.update(t)) : this._$EM();
    } catch (o) {
      throw e = !1, this._$EM(), o;
    }
    e && this._$AE(t);
  }
  willUpdate(e) {
  }
  _$AE(e) {
    var t;
    (t = this._$EO) == null || t.forEach((i) => {
      var o;
      return (o = i.hostUpdated) == null ? void 0 : o.call(i);
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
I.elementStyles = [], I.shadowRootOptions = { mode: "open" }, I[U("elementProperties")] = /* @__PURE__ */ new Map(), I[U("finalized")] = /* @__PURE__ */ new Map(), ie == null || ie({ ReactiveElement: I }), (z.reactiveElementVersions ?? (z.reactiveElementVersions = [])).push("2.1.2");
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const W = globalThis, fe = (r) => r, X = W.trustedTypes, ke = X ? X.createPolicy("lit-html", { createHTML: (r) => r }) : void 0, qe = "$lit$", S = `lit$${Math.random().toFixed(9).slice(2)}$`, Ke = "?" + S, ht = `<${Ke}>`, H = document, B = () => H.createComment(""), G = (r) => r === null || typeof r != "object" && typeof r != "function", ue = Array.isArray, ut = (r) => ue(r) || typeof (r == null ? void 0 : r[Symbol.iterator]) == "function", oe = `[ 	
\f\r]`, N = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g, we = /-->/g, $e = />/g, P = RegExp(`>|${oe}(?:([^\\s"'>=/]+)(${oe}*=${oe}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`, "g"), xe = /'/g, Ee = /"/g, Be = /^(?:script|style|textarea|title)$/i, gt = (r) => (e, ...t) => ({ _$litType$: r, strings: e, values: t }), d = gt(1), R = Symbol.for("lit-noChange"), p = Symbol.for("lit-nothing"), Ae = /* @__PURE__ */ new WeakMap(), V = H.createTreeWalker(H, 129);
function Ge(r, e) {
  if (!ue(r) || !r.hasOwnProperty("raw")) throw Error("invalid template strings array");
  return ke !== void 0 ? ke.createHTML(e) : e;
}
const mt = (r, e) => {
  const t = r.length - 1, i = [];
  let o, a = e === 2 ? "<svg>" : e === 3 ? "<math>" : "", n = N;
  for (let s = 0; s < t; s++) {
    const l = r[s];
    let c, _, h = -1, w = 0;
    for (; w < l.length && (n.lastIndex = w, _ = n.exec(l), _ !== null); ) w = n.lastIndex, n === N ? _[1] === "!--" ? n = we : _[1] !== void 0 ? n = $e : _[2] !== void 0 ? (Be.test(_[2]) && (o = RegExp("</" + _[2], "g")), n = P) : _[3] !== void 0 && (n = P) : n === P ? _[0] === ">" ? (n = o ?? N, h = -1) : _[1] === void 0 ? h = -2 : (h = n.lastIndex - _[2].length, c = _[1], n = _[3] === void 0 ? P : _[3] === '"' ? Ee : xe) : n === Ee || n === xe ? n = P : n === we || n === $e ? n = N : (n = P, o = void 0);
    const E = n === P && r[s + 1].startsWith("/>") ? " " : "";
    a += n === N ? l + ht : h >= 0 ? (i.push(c), l.slice(0, h) + qe + l.slice(h) + S + E) : l + S + (h === -2 ? s : E);
  }
  return [Ge(r, a + (r[t] || "<?>") + (e === 2 ? "</svg>" : e === 3 ? "</math>" : "")), i];
};
class J {
  constructor({ strings: e, _$litType$: t }, i) {
    let o;
    this.parts = [];
    let a = 0, n = 0;
    const s = e.length - 1, l = this.parts, [c, _] = mt(e, t);
    if (this.el = J.createElement(c, i), V.currentNode = this.el.content, t === 2 || t === 3) {
      const h = this.el.content.firstChild;
      h.replaceWith(...h.childNodes);
    }
    for (; (o = V.nextNode()) !== null && l.length < s; ) {
      if (o.nodeType === 1) {
        if (o.hasAttributes()) for (const h of o.getAttributeNames()) if (h.endsWith(qe)) {
          const w = _[n++], E = o.getAttribute(h).split(S), Z = /([.?@])?(.*)/.exec(w);
          l.push({ type: 1, index: a, name: Z[2], strings: E, ctor: Z[1] === "." ? vt : Z[1] === "?" ? bt : Z[1] === "@" ? ft : te }), o.removeAttribute(h);
        } else h.startsWith(S) && (l.push({ type: 6, index: a }), o.removeAttribute(h));
        if (Be.test(o.tagName)) {
          const h = o.textContent.split(S), w = h.length - 1;
          if (w > 0) {
            o.textContent = X ? X.emptyScript : "";
            for (let E = 0; E < w; E++) o.append(h[E], B()), V.nextNode(), l.push({ type: 2, index: ++a });
            o.append(h[w], B());
          }
        }
      } else if (o.nodeType === 8) if (o.data === Ke) l.push({ type: 2, index: a });
      else {
        let h = -1;
        for (; (h = o.data.indexOf(S, h + 1)) !== -1; ) l.push({ type: 7, index: a }), h += S.length - 1;
      }
      a++;
    }
  }
  static createElement(e, t) {
    const i = H.createElement("template");
    return i.innerHTML = e, i;
  }
}
function T(r, e, t = r, i) {
  var n, s;
  if (e === R) return e;
  let o = i !== void 0 ? (n = t._$Co) == null ? void 0 : n[i] : t._$Cl;
  const a = G(e) ? void 0 : e._$litDirective$;
  return (o == null ? void 0 : o.constructor) !== a && ((s = o == null ? void 0 : o._$AO) == null || s.call(o, !1), a === void 0 ? o = void 0 : (o = new a(r), o._$AT(r, t, i)), i !== void 0 ? (t._$Co ?? (t._$Co = []))[i] = o : t._$Cl = o), o !== void 0 && (e = T(r, o._$AS(r, e.values), o, i)), e;
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
    const { el: { content: t }, parts: i } = this._$AD, o = ((e == null ? void 0 : e.creationScope) ?? H).importNode(t, !0);
    V.currentNode = o;
    let a = V.nextNode(), n = 0, s = 0, l = i[0];
    for (; l !== void 0; ) {
      if (n === l.index) {
        let c;
        l.type === 2 ? c = new F(a, a.nextSibling, this, e) : l.type === 1 ? c = new l.ctor(a, l.name, l.strings, this, e) : l.type === 6 && (c = new kt(a, this, e)), this._$AV.push(c), l = i[++s];
      }
      n !== (l == null ? void 0 : l.index) && (a = V.nextNode(), n++);
    }
    return V.currentNode = H, o;
  }
  p(e) {
    let t = 0;
    for (const i of this._$AV) i !== void 0 && (i.strings !== void 0 ? (i._$AI(e, i, t), t += i.strings.length - 2) : i._$AI(e[t])), t++;
  }
}
class F {
  get _$AU() {
    var e;
    return ((e = this._$AM) == null ? void 0 : e._$AU) ?? this._$Cv;
  }
  constructor(e, t, i, o) {
    this.type = 2, this._$AH = p, this._$AN = void 0, this._$AA = e, this._$AB = t, this._$AM = i, this.options = o, this._$Cv = (o == null ? void 0 : o.isConnected) ?? !0;
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
    e = T(this, e, t), G(e) ? e === p || e == null || e === "" ? (this._$AH !== p && this._$AR(), this._$AH = p) : e !== this._$AH && e !== R && this._(e) : e._$litType$ !== void 0 ? this.$(e) : e.nodeType !== void 0 ? this.T(e) : ut(e) ? this.k(e) : this._(e);
  }
  O(e) {
    return this._$AA.parentNode.insertBefore(e, this._$AB);
  }
  T(e) {
    this._$AH !== e && (this._$AR(), this._$AH = this.O(e));
  }
  _(e) {
    this._$AH !== p && G(this._$AH) ? this._$AA.nextSibling.data = e : this.T(H.createTextNode(e)), this._$AH = e;
  }
  $(e) {
    var a;
    const { values: t, _$litType$: i } = e, o = typeof i == "number" ? this._$AC(e) : (i.el === void 0 && (i.el = J.createElement(Ge(i.h, i.h[0]), this.options)), i);
    if (((a = this._$AH) == null ? void 0 : a._$AD) === o) this._$AH.p(t);
    else {
      const n = new yt(o, this), s = n.u(this.options);
      n.p(t), this.T(s), this._$AH = n;
    }
  }
  _$AC(e) {
    let t = Ae.get(e.strings);
    return t === void 0 && Ae.set(e.strings, t = new J(e)), t;
  }
  k(e) {
    ue(this._$AH) || (this._$AH = [], this._$AR());
    const t = this._$AH;
    let i, o = 0;
    for (const a of e) o === t.length ? t.push(i = new F(this.O(B()), this.O(B()), this, this.options)) : i = t[o], i._$AI(a), o++;
    o < t.length && (this._$AR(i && i._$AB.nextSibling, o), t.length = o);
  }
  _$AR(e = this._$AA.nextSibling, t) {
    var i;
    for ((i = this._$AP) == null ? void 0 : i.call(this, !1, !0, t); e !== this._$AB; ) {
      const o = fe(e).nextSibling;
      fe(e).remove(), e = o;
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
  constructor(e, t, i, o, a) {
    this.type = 1, this._$AH = p, this._$AN = void 0, this.element = e, this.name = t, this._$AM = o, this.options = a, i.length > 2 || i[0] !== "" || i[1] !== "" ? (this._$AH = Array(i.length - 1).fill(new String()), this.strings = i) : this._$AH = p;
  }
  _$AI(e, t = this, i, o) {
    const a = this.strings;
    let n = !1;
    if (a === void 0) e = T(this, e, t, 0), n = !G(e) || e !== this._$AH && e !== R, n && (this._$AH = e);
    else {
      const s = e;
      let l, c;
      for (e = a[0], l = 0; l < a.length - 1; l++) c = T(this, s[i + l], t, l), c === R && (c = this._$AH[l]), n || (n = !G(c) || c !== this._$AH[l]), c === p ? e = p : e !== p && (e += (c ?? "") + a[l + 1]), this._$AH[l] = c;
    }
    n && !o && this.j(e);
  }
  j(e) {
    e === p ? this.element.removeAttribute(this.name) : this.element.setAttribute(this.name, e ?? "");
  }
}
class vt extends te {
  constructor() {
    super(...arguments), this.type = 3;
  }
  j(e) {
    this.element[this.name] = e === p ? void 0 : e;
  }
}
class bt extends te {
  constructor() {
    super(...arguments), this.type = 4;
  }
  j(e) {
    this.element.toggleAttribute(this.name, !!e && e !== p);
  }
}
class ft extends te {
  constructor(e, t, i, o, a) {
    super(e, t, i, o, a), this.type = 5;
  }
  _$AI(e, t = this) {
    if ((e = T(this, e, t, 0) ?? p) === R) return;
    const i = this._$AH, o = e === p && i !== p || e.capture !== i.capture || e.once !== i.once || e.passive !== i.passive, a = e !== p && (i === p || o);
    o && this.element.removeEventListener(this.name, this, i), a && this.element.addEventListener(this.name, this, e), this._$AH = e;
  }
  handleEvent(e) {
    var t;
    typeof this._$AH == "function" ? this._$AH.call(((t = this.options) == null ? void 0 : t.host) ?? this.element, e) : this._$AH.handleEvent(e);
  }
}
class kt {
  constructor(e, t, i) {
    this.element = e, this.type = 6, this._$AN = void 0, this._$AM = t, this.options = i;
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  _$AI(e) {
    T(this, e);
  }
}
const wt = { I: F }, re = W.litHtmlPolyfillSupport;
re == null || re(J, F), (W.litHtmlVersions ?? (W.litHtmlVersions = [])).push("3.3.2");
const Je = (r, e, t) => {
  const i = (t == null ? void 0 : t.renderBefore) ?? e;
  let o = i._$litPart$;
  if (o === void 0) {
    const a = (t == null ? void 0 : t.renderBefore) ?? null;
    i._$litPart$ = o = new F(e.insertBefore(B(), a), a, void 0, t ?? {});
  }
  return o._$AI(r), o;
};
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const C = globalThis;
let q = class extends I {
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
    this.hasUpdated || (this.renderOptions.isConnected = this.isConnected), super.update(e), this._$Do = Je(t, this.renderRoot, this.renderOptions);
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
    return R;
  }
};
var Ye;
q._$litElement$ = !0, q.finalized = !0, (Ye = C.litElementHydrateSupport) == null || Ye.call(C, { LitElement: q });
const ae = C.litElementPolyfillSupport;
ae == null || ae({ LitElement: q });
(C.litElementVersions ?? (C.litElementVersions = [])).push("4.2.2");
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const $t = (r) => (...e) => ({ _$litDirective$: r, values: e });
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
const { I: Et } = wt, je = (r) => r, Se = (r, e) => (r == null ? void 0 : r._$litType$) !== void 0, At = (r) => {
  var e;
  return ((e = r == null ? void 0 : r._$litType$) == null ? void 0 : e.h) != null;
}, ze = () => document.createComment(""), Me = (r, e, t) => {
  var a;
  const i = r._$AA.parentNode, o = r._$AB;
  if (t === void 0) {
    const n = i.insertBefore(ze(), o), s = i.insertBefore(ze(), o);
    t = new Et(n, s, r, r.options);
  } else {
    const n = t._$AB.nextSibling, s = t._$AM, l = s !== r;
    if (l) {
      let c;
      (a = t._$AQ) == null || a.call(t, r), t._$AM = r, t._$AP !== void 0 && (c = r._$AU) !== s._$AU && t._$AP(c);
    }
    if (n !== o || l) {
      let c = t._$AA;
      for (; c !== n; ) {
        const _ = je(c).nextSibling;
        je(i).insertBefore(c, o), c = _;
      }
    }
  }
  return t;
}, jt = {}, Pe = (r, e = jt) => r._$AH = e, Oe = (r) => r._$AH, St = (r) => {
  r._$AR();
};
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const Ve = (r) => At(r) ? r._$litType$.h : r.strings, zt = $t(class extends xt {
  constructor(r) {
    super(r), this.et = /* @__PURE__ */ new WeakMap();
  }
  render(r) {
    return [r];
  }
  update(r, [e]) {
    const t = Se(this.it) ? Ve(this.it) : null, i = Se(e) ? Ve(e) : null;
    if (t !== null && (i === null || t !== i)) {
      const o = Oe(r).pop();
      let a = this.et.get(t);
      if (a === void 0) {
        const n = document.createDocumentFragment();
        a = Je(p, n), a.setConnected(!1), this.et.set(t, a);
      }
      Pe(a, [o]), Me(a, void 0, o);
    }
    if (i !== null) {
      if (t === null || t !== i) {
        const o = this.et.get(i);
        if (o !== void 0) {
          const a = Oe(o).pop();
          St(r), Me(r, void 0, a), Pe(r, [a]);
        }
      }
      this.it = e;
    } else this.it = void 0;
    return this.render(e);
  }
});
function y(r) {
  return typeof structuredClone == "function" ? structuredClone(r) : JSON.parse(JSON.stringify(r));
}
function x(r) {
  return typeof r == "object" && r !== null && !Array.isArray(r);
}
function v(r) {
  return x(r) ? r : void 0;
}
function b(r) {
  return Array.isArray(r) ? r : void 0;
}
function A(r) {
  const e = v(r);
  return e ? Object.entries(e) : [];
}
function k(r, e) {
  let t = r;
  for (const i of e) {
    if (typeof i == "number") {
      if (!Array.isArray(t))
        return;
      t = t[i];
      continue;
    }
    if (!x(t))
      return;
    t = t[i];
  }
  return t;
}
function m(r, e, t) {
  if (e.length === 0)
    return;
  let i = r;
  for (let a = 0; a < e.length - 1; a += 1) {
    const n = e[a], l = typeof e[a + 1] == "number";
    if (typeof n == "number") {
      if (!Array.isArray(i))
        return;
      let _ = i[n];
      l ? Array.isArray(_) || (_ = [], i[n] = _) : x(_) || (_ = {}, i[n] = _), i = _;
      continue;
    }
    let c = i[n];
    l ? Array.isArray(c) || (c = [], i[n] = c) : x(c) || (c = {}, i[n] = c), i = c;
  }
  const o = e[e.length - 1];
  if (typeof o == "number") {
    if (!Array.isArray(i))
      return;
    i[o] = t;
    return;
  }
  i[o] = t;
}
function K(r, e) {
  e.length !== 0 && (Qe(r, e), Wt(r, e.slice(0, -1)));
}
function O(r, e, t) {
  const i = k(r, e), a = [...Array.isArray(i) ? i : [], t];
  m(r, e, a);
}
function Mt(r, e, t) {
  const i = k(r, e);
  if (!Array.isArray(i) || t < 0 || t >= i.length)
    return;
  const o = i.filter((a, n) => n !== t);
  if (o.length === 0) {
    K(r, e);
    return;
  }
  m(r, e, o);
}
function Pt(r, e, t, i) {
  const o = k(r, e);
  if (!Array.isArray(o) || t < 0 || i < 0 || t >= o.length || i >= o.length || t === i)
    return;
  const a = [...o], [n] = a.splice(t, 1);
  a.splice(i, 0, n), m(r, e, a);
}
function Ot(r, e, t, i) {
  const o = k(r, e);
  if (!x(o))
    return { ok: !1, reason: "target_not_available" };
  const a = i.trim();
  if (!a)
    return { ok: !1, reason: "empty_key" };
  if (a === t)
    return { ok: !0 };
  if (Object.prototype.hasOwnProperty.call(o, a))
    return { ok: !1, reason: "duplicate_key", key: a };
  if (o[t] === void 0)
    return { ok: !1, reason: "missing_key", key: t };
  const s = {};
  for (const [l, c] of Object.entries(o)) {
    if (l === t) {
      s[a] = c;
      continue;
    }
    s[l] = c;
  }
  return m(r, e, s), { ok: !0 };
}
function Vt(r) {
  return M(r, "category");
}
function Ct(r) {
  return M(r, "label");
}
function Ht(r, e, t) {
  return {
    kind: "ev_charger",
    id: M(r, "ev-charger"),
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
function It(r, e) {
  return {
    kind: "generic",
    id: M(r, "generic-appliance"),
    name: e,
    controls: {
      switch: {
        entity_id: ""
      }
    },
    projection: {
      strategy: "fixed",
      hourly_energy_kwh: 1
    }
  };
}
function Rt(r, e) {
  return {
    kind: "climate",
    id: M(r, "climate-appliance"),
    name: e,
    controls: {
      climate: {
        entity_id: ""
      }
    },
    projection: {
      strategy: "fixed",
      hourly_energy_kwh: 1
    }
  };
}
function Ze(r, e) {
  return {
    id: M(r, "vehicle"),
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
function Tt() {
  return {
    behavior: "fixed_max_power"
  };
}
function Ft() {
  return {
    min_power_kw: 1.4
  };
}
function Nt(r) {
  return {
    energy_entity_id: "",
    label: r
  };
}
function Lt() {
  return {
    start: "00:00",
    end: "06:00",
    price: 1
  };
}
function Dt() {
  return "";
}
function Yt(r) {
  return M(r, "mode");
}
function Ut(r) {
  return M(r, "gear");
}
function Qe(r, e) {
  const t = e.slice(0, -1), i = t.length === 0 ? r : k(r, t);
  if (i === void 0)
    return;
  const o = e[e.length - 1];
  if (typeof o == "number") {
    if (!Array.isArray(i) || o < 0 || o >= i.length)
      return;
    i.splice(o, 1);
    return;
  }
  !x(i) || !(o in i) || delete i[o];
}
function Wt(r, e) {
  for (let t = e.length; t > 0; t -= 1) {
    const i = e.slice(0, t), o = k(r, i), a = x(o) && Object.keys(o).length === 0, n = Array.isArray(o) && o.length === 0;
    if (!a && !n)
      break;
    Qe(r, i);
  }
}
function M(r, e) {
  const t = new Set(r);
  if (!t.has(e))
    return e;
  let i = 2;
  for (; t.has(`${e}-${i}`); )
    i += 1;
  return `${e}-${i}`;
}
function qt() {
  return {
    read(r) {
      return y(r);
    },
    apply(r, e) {
      return y(e);
    },
    validate(r) {
      return ge(r, "object");
    }
  };
}
function f(r, e) {
  return {
    read(t) {
      const i = r.length === 0 ? t : k(t, r);
      return y(i === void 0 ? e.emptyValue : i);
    },
    apply(t, i) {
      if (r.length === 0)
        return y(i);
      const o = y(t);
      return m(o, r, y(i)), o;
    },
    validate(t) {
      return ge(t, e.rootKind);
    }
  };
}
function Ce(r) {
  const e = new Map(r.map((t) => [t.yamlKey, t]));
  return {
    read(t) {
      const i = {};
      for (const o of r) {
        const a = k(t, o.documentPath);
        a !== void 0 && (i[o.yamlKey] = y(a));
      }
      return i;
    },
    apply(t, i) {
      const o = y(t), a = i;
      for (const n of r)
        K(o, n.documentPath);
      for (const n of r) {
        const s = a[n.yamlKey];
        s !== void 0 && m(o, n.documentPath, y(s));
      }
      return o;
    },
    validate(t) {
      const i = ge(t, "object");
      if (i)
        return i;
      if (!x(t))
        return { code: "expected_object" };
      for (const o of Object.keys(t))
        if (!e.has(o))
          return { code: "unexpected_key", key: o };
      return null;
    }
  };
}
function ge(r, e) {
  return e === "array" ? Array.isArray(r) ? null : { code: "expected_array" } : x(r) ? null : { code: "expected_object" };
}
const Kt = [
  { id: "general", labelKey: "editor.tabs.general" },
  { id: "power_devices", labelKey: "editor.tabs.power_devices" },
  { id: "scheduler", labelKey: "editor.tabs.scheduler" },
  { id: "appliances", labelKey: "editor.tabs.appliances" }
], He = {
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
  (r) => r !== "device_label_text"
), j = {}, Ie = [], Gt = et(Xe), Jt = et(
  Bt
), de = {
  [$]: {
    id: $,
    kind: "document",
    labelKey: "editor.title",
    adapter: qt()
  },
  [g.general]: {
    id: g.general,
    kind: "tab",
    parentId: $,
    tabId: "general",
    labelKey: "editor.tabs.general",
    adapter: Ce(Gt)
  },
  [g.power_devices]: {
    id: g.power_devices,
    kind: "tab",
    parentId: $,
    tabId: "power_devices",
    labelKey: "editor.tabs.power_devices",
    adapter: f(["power_devices"], {
      emptyValue: j,
      rootKind: "object"
    })
  },
  [g.scheduler]: {
    id: g.scheduler,
    kind: "tab",
    parentId: $,
    tabId: "scheduler",
    labelKey: "editor.tabs.scheduler",
    adapter: f(["scheduler"], {
      emptyValue: j,
      rootKind: "object"
    })
  },
  [g.appliances]: {
    id: g.appliances,
    kind: "tab",
    parentId: $,
    tabId: "appliances",
    labelKey: "editor.tabs.appliances",
    adapter: f(["appliances"], {
      emptyValue: Ie,
      rootKind: "array"
    })
  },
  [u.general.core_labels_and_history]: {
    id: u.general.core_labels_and_history,
    kind: "section",
    parentId: g.general,
    tabId: "general",
    labelKey: "editor.sections.core_labels_and_history",
    adapter: Ce(Jt)
  },
  [u.general.device_label_text]: {
    id: u.general.device_label_text,
    kind: "section",
    parentId: g.general,
    tabId: "general",
    labelKey: "editor.sections.device_label_text",
    adapter: f(["device_label_text"], {
      emptyValue: j,
      rootKind: "object"
    })
  },
  [u.power_devices.house]: {
    id: u.power_devices.house,
    kind: "section",
    parentId: g.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.house",
    adapter: f(["power_devices", "house"], {
      emptyValue: j,
      rootKind: "object"
    })
  },
  [u.power_devices.solar]: {
    id: u.power_devices.solar,
    kind: "section",
    parentId: g.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.solar",
    adapter: f(["power_devices", "solar"], {
      emptyValue: j,
      rootKind: "object"
    })
  },
  [u.power_devices.battery]: {
    id: u.power_devices.battery,
    kind: "section",
    parentId: g.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.battery",
    adapter: f(["power_devices", "battery"], {
      emptyValue: j,
      rootKind: "object"
    })
  },
  [u.power_devices.grid]: {
    id: u.power_devices.grid,
    kind: "section",
    parentId: g.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.grid",
    adapter: f(["power_devices", "grid"], {
      emptyValue: j,
      rootKind: "object"
    })
  },
  [u.scheduler.schedule_control_mapping]: {
    id: u.scheduler.schedule_control_mapping,
    kind: "section",
    parentId: g.scheduler,
    tabId: "scheduler",
    labelKey: "editor.sections.schedule_control_mapping",
    adapter: f(["scheduler", "control"], {
      emptyValue: j,
      rootKind: "object"
    })
  },
  [u.appliances.configured_appliances]: {
    id: u.appliances.configured_appliances,
    kind: "section",
    parentId: g.appliances,
    tabId: "appliances",
    labelKey: "editor.sections.configured_appliances",
    adapter: f(["appliances"], {
      emptyValue: Ie,
      rootKind: "array"
    })
  }
}, Re = Zt();
function L(r) {
  return de[r];
}
function Te(r) {
  const e = [], t = [...Re[r]];
  for (; t.length > 0; ) {
    const i = t.pop();
    i && (e.push(i), t.push(...Re[i]));
  }
  return e;
}
function et(r) {
  return r.map((e) => ({
    yamlKey: e,
    documentPath: [e]
  }));
}
function Zt() {
  const r = Object.fromEntries(
    Object.keys(de).map((e) => [e, []])
  );
  for (const e of Object.values(de))
    e.parentId && r[e.parentId].push(e.id);
  return r;
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
    add_climate_appliance: "Přidat topení/klimatizaci",
    add_generic_appliance: "Přidat obecný spotřebič",
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
    projection: "Projekce",
    use_modes: "Režimy použití",
    eco_gears: "Eco gears",
    vehicles: "Vozidla"
  },
  notes: {
    device_label_text: "Nakonfigurujte mapy textů štítků, například místnosti nebo vlastní skupiny štítků. Neznámé kategorie a položky se zachovají.",
    battery_entities: "Remaining energy, capacity, min SoC a max SoC fungují jako jedna skupina bateriových entit. Pokud zapnete predikci baterie, nastavte je společně.",
    grid_import_windows: "Okna cen importu musí pokrývat celý den bez mezer nebo překryvů.",
    appliances: "Editace EV nabíječky, topení/klimatizace a obecného spotřebiče je podporovaná přímo. Nepodporované budoucí typy spotřebičů se zachovají a zobrazí jen pro čtení, dokud je neodstraníte.",
    generic_appliance_projection: "Nastavte pevnou průměrnou hodinovou energii v kWh. Když je vybraná historická průměrná hodnota, Helman odhadne průměrnou hodinovou energii během zapnutého přepínače a při nedostatečné historii použije pevnou hodnotu.",
    climate_appliance_projection: "Nastavte pevnou průměrnou hodinovou energii v kWh. Když je vybraná historická průměrná hodnota, Helman odhadne průměrnou hodinovou energii během aktivního vytápění nebo chlazení a při nedostatečné historii použije pevnou hodnotu."
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
    appliance_icon: "Ikona spotřebiče",
    kind: "Druh",
    climate_entity: "Entita topení/klimatizace",
    switch_entity: "Entita přepínače",
    projection_strategy: "Strategie projekce",
    hourly_energy_kwh: "Průměrná hodinová energie kWh",
    history_energy_entity: "Entita energie pro historii",
    history_lookback_days: "Počet dní historie",
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
    mode_entity: "Helman zapisuje volby akcí plánování do této entity.",
    appliance_icon: "Volitelné. Když pole necháte prázdné, metadata spotřebiče použijí výchozí energetickou ikonu.",
    history_energy_entity: "Použijte kumulativní senzor energie, který sleduje spotřebu spotřebiče."
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
    fixed: "Pevná hodnota",
    history_average: "Historický průměr",
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
    climate_appliance: "Topení/klimatizace {index}",
    generic_appliance: "Obecný spotřebič {index}",
    vehicle: "Vozidlo {index}",
    unsupported_appliance_kind: "Nepodporovaný typ spotřebiče: {kind}"
  },
  help: {
    aria_label: "Nápověda k poli",
    close: "Zavřít",
    history_buckets: "Počet historických slotů, které Helman uchovává pro graf historie v UI. Každý slot pokrývá jedno období délky bucketu. Pokud není nastaveno, použije se výchozí hodnota.",
    history_bucket_duration: "Délka jednoho bucketu historie v hodinách. Určuje rozlišení grafu historie v UI. Pokud není nastaveno, použije se výchozí hodnota.",
    power_sensor_name_cleaner_regex: "Volitelný regulární výraz použitý při normalizaci zobrazovaných názvů power senzorů v UI. Hodí se pro odstranění společných předpon nebo přípon z názvů entit.",
    house_power_entity: "Senzor okamžité spotřeby domu (W). Vyžadován pro živé sledování spotřeby na dashboardu. Bez něj nejsou data o spotřebě domu k dispozici.",
    house_forecast_total_energy_entity: "Kumulativní (stále rostoucí) senzor energie, který sleduje celkovou spotřebu elektřiny domu v kWh. Helman dotazuje jeho dlouhodobou historii z HA Recorderu pro trénování modelu předpovědi spotřeby. Bez něj je předpověď spotřeby domu zcela vypnuta.",
    house_min_history_days: "Minimální počet dní zaznamenané historie potřebný k tomu, aby byla předpověď spotřeby považována za platnou. Pokud má entita kratší historii, předpověď hlásí nedostatek dat. Výchozí hodnota je 14 dní.",
    house_training_window_days: "Kolik minulých dní Helman používá pro trénování modelu předpovědi spotřeby. Větší okno produkuje stabilnější vzory, ale reaguje pomaleji na změny v životním stylu. Výchozí hodnota je 56 dní.",
    solar_power_entity: "Senzor okamžitého výkonu solárních panelů (W). Slouží k živému sledování solární výroby na dashboardu. Volitelné — bez něj není solární výkon sledován.",
    solar_today_energy_entity: "Senzor solární energie s denním nulovým resetem (kWh vyrobeno dnes). Slouží jako záložní zdroj pro overlay skutečné dnešní solární výroby na grafu, pokud není nakonfiguována celková entita energie.",
    solar_remaining_today_energy_forecast: "Entita poskytující předpověď zbývající solární energie očekávané pro zbytek dnešního dne (kWh). Zobrazuje se na dashboardu jako indikace očekávané zbývající výroby.",
    solar_forecast_total_energy_entity: "Kumulativní senzor solární energie (kWh, stále rostoucí). Primární zdroj pro vytváření overlayu skutečné výroby na grafu solární předpovědi. Pokud není nastaveno, použije se dnešní entita energie.",
    solar_daily_energy_entity: "Entita externího poskytovatele solární předpovědi (např. Forecast.Solar), která hlásí předpovídanou denní energii v kWh. Helman tyto entity používá pro sestavení předpovědi solární výroby. Přidejte jednu entitu na zdroj předpovědi.",
    battery_power_entity: "Senzor okamžitého výkonu nabíjení/vybíjení baterie (W, kladné = nabíjení, záporné = vybíjení). Slouží k živému sledování baterie. Volitelné — bez něj není výkon baterie sledován.",
    battery_remaining_energy_entity: "Senzor hlásící aktuální zbývající energii v baterii v kWh. Spolu s entitou kapacity umožňuje výpočet stavu nabití a předpověď baterie. Součást skupiny entit baterie.",
    battery_capacity_entity: "Senzor hlásící celkovou využitelnou kapacitu baterie v kWh. Slouží k výpočtu procenta stavu nabití. Součást skupiny entit baterie.",
    battery_min_soc_entity: "Senzor nebo číselná entita hlásící minimální povolený stav nabití (%). Helman neplánuje vybíjení pod tuto úroveň. Součást skupiny entit baterie.",
    battery_max_soc_entity: "Senzor nebo číselná entita hlásící maximální povolený stav nabití (%). Helman neplánuje nabíjení nad tuto úroveň. Součást skupiny entit baterie.",
    battery_charge_efficiency: "Účinnost nabíjení baterie jako desetinné číslo mezi 0 a 1 (např. 0,95 = 95 %). Energie uložená ÷ energie odebraná ze sítě. Používá se optimalizátorem pro přesné modelování nákladů nabíjení. Výchozí hodnota je 0,95.",
    battery_discharge_efficiency: "Účinnost vybíjení baterie jako desetinné číslo mezi 0 a 1 (např. 0,95 = 95 %). Energie dodaná ÷ energie uložená. Používá se optimalizátorem pro modelování výnosů z vybíjení. Výchozí hodnota je 0,95.",
    battery_max_charge_power_w: "Maximální výkon nabíjení baterie ve wattech. Slouží k modelování rychlosti a délky nabíjení v optimalizátoru plánování. Bez tohoto nastavení optimalizátor nemůže přesně odhadnout okna nabíjení.",
    battery_max_discharge_power_w: "Maximální výkon vybíjení baterie ve wattech. Slouží k modelování rychlosti a délky vybíjení v optimalizátoru plánování. Bez tohoto nastavení optimalizátor nemůže přesně odhadnout okna vybíjení.",
    grid_power_entity: "Senzor okamžitého výkonu importu/exportu ze sítě (W, kladné = import, záporné = export). Slouží k živému sledování sítě na dashboardu. Volitelné — bez něj není výkon sítě sledován.",
    grid_sell_price_entity: "Entita poskytující aktuální výkupní cenu elektřiny do sítě. Používá ji optimalizátor baterie k vyhodnocení, zda je v daný čas výhodné dodávat energii do sítě. Bez ní je výkupní cena považována za nulovou.",
    grid_import_price_unit: "Jednotka zobrazená u cen importu na dashboardu (např. CZK/kWh, EUR/kWh). Pouze kosmetická — nemá vliv na výpočty.",
    import_window_start: "Čas začátku tohoto cenového okna importu v místním čase (HH:MM). Cenová okna importu musí dohromady pokrývat celých 24 hodin bez mezer ani překryvů.",
    import_window_end: "Čas konce tohoto cenového okna importu v místním čase (HH:MM). Pro půlnoc na konci dne použijte 00:00.",
    import_window_price: "Cena elektřiny při importu v průběhu tohoto časového okna, v jednotce nakonfigurované výše. Optimalizátor baterie ji používá k nalezení nejlevnějších čas pro nabíjení.",
    scheduler_mode_entity: "Entita input_select nebo select, do které Helman zapisuje příkazy akcí plánování. Helman nastaví hodnotu volby odpovídající požadovanému režimu baterie (nabíjení, vybíjení, normální atd.). Vyžadováno pro skutečné řízení baterie plánovačem.",
    scheduler_action_option: "Hodnota volby, kterou Helman zapíše do entity režimu při naplánování této akce. Musí přesně odpovídat jedné z voleb v entitě select. Nechte prázdné, pokud vaše střídač tuto akci nepodporuje.",
    deferrable_consumer_energy_entity: "Kumulativní senzor energie (kWh) sledující celkovou spotřebu elektřiny tohoto spotřebiče. Helman používá jeho zaznamenanou historii k odhadu, kolik energie tento spotřebič spotřebuje v nadcházejících časových slotech, aby ho mohl přesunout do levnějších period.",
    appliance_id: "Jedinečný interní identifikátor tohoto spotřebiče. Používá se v odkazech automatizací a sledování plánování. Neměňte ho po nakonfigurování spotřebiče, mohlo by to rozbít existující automatizace.",
    appliance_name: "Zobrazovaný název tohoto spotřebiče v dashboardu Helman a přehledech energie.",
    ev_max_charging_power_kw: "Maximální výkon nabíjení EV nabíječky v kW. Optimalizátor ho používá k modelování rychlosti nabíjení vozidla a plánování oken nabíjení.",
    ev_charge_switch_entity: "Entita přepínače, která fyzicky povoluje nebo zakazuje nabíjení EV. Helman ji zapíná a vypíná pro realizaci plánu nabíjení. Musí být skutečný řídicí přepínač vaší nabíječky.",
    ev_use_mode_entity: "Entita select nebo input_select, která ovládá provozní režim EV nabíječky (např. pevný maximální výkon, řízení přebytkem). Helman zapisuje aktivní režim do této entity pro realizaci naplánovaného chování nabíjení.",
    ev_eco_gear_entity: "Entita select nebo input_select, která ovládá úroveň eco gear (krok výkonu nabíjení) EV nabíječky. Helman ji řídí v režimu řízení přebytkem pro škrcení nabíjení na dostupný solární přebytek.",
    appliance_climate_entity: "Entita klimatizace pro tento spotřebič. Helman sleduje její aktivní/neaktivní stav (režim topení nebo chlazení) pro tvorbu energetických predikcí na základě historie. Vyžadováno pro strategii history_average.",
    appliance_switch_entity: "Entita přepínače, která ovládá tento obecný spotřebič. Helman sleduje historii stavů zapnuto/vypnuto pro energetické predikce při použití strategie history_average.",
    appliance_projection_strategy: "Jak Helman odhaduje budoucí spotřebu energie tohoto spotřebiče. Pevná: vždy používá nakonfigurovanou průměrnou hodinovou energii. Historický průměr: učí se ze zaznamenané historie entity a při nedostatku dat se vrátí na pevnou hodnotu.",
    appliance_hourly_energy_kwh: "Průměrná spotřeba energie za hodinu v kWh, když je spotřebič aktivní. Používá se přímo pro pevnou strategii a jako záložní hodnota pro historický průměr, pokud zaznamenaná historie nestačí.",
    appliance_history_lookback_days: "Kolik dní zpětně Helman zohledňuje při výpočtu historického průměru spotřeby energie tohoto spotřebiče. Delší lookback dává stabilnější odhady, ale reaguje pomaleji na změny ve vzorcích používání.",
    vehicle_id: "Jedinečný interní identifikátor tohoto vozidla. Používá se pro sledování cílů nabíjení a přiřazení plánování. Neměňte ho po nakonfigurování vozidla.",
    vehicle_soc_entity: "Senzor hlásící aktuální stav nabití baterie vozidla v procentech (0–100). Vyžadováno pro plánování nabíjení s ohledem na vozidlo — Helman ho používá k určení, kolik nabíjení je potřeba.",
    vehicle_charge_limit_entity: "Číselná entita hlásící nakonfigurovaný limit nabíjení vozidla v procentech (0–100). Pokud je nastavena, Helman ji používá jako cílový SoC místo předpokladu 100 %. Volitelné.",
    vehicle_battery_capacity_kwh: "Celková využitelná kapacita baterie vozidla v kWh. Vyžadováno pro přesné výpočty cíle nabíjení a délky nabíjení.",
    vehicle_max_charging_power_kw: "Maximální výkon AC nabíjení tohoto vozidla v kW. Slouží k modelování rychlosti nabíjení vozidla a plánování délky oken nabíjení."
  }
}, Qt = {
  editor: tt
}, Xt = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: Qt,
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
    add_climate_appliance: "Add climate appliance",
    add_generic_appliance: "Add generic appliance",
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
    projection: "Projection",
    use_modes: "Use modes",
    eco_gears: "Eco gears",
    vehicles: "Vehicles"
  },
  notes: {
    device_label_text: "Configure badge text maps such as rooms or custom label groups. Unknown categories and entries are preserved.",
    battery_entities: "Remaining energy, capacity, min SoC, and max SoC work as one battery entity group. Configure them together when battery forecasting is enabled.",
    grid_import_windows: "Import price windows must cover the whole day without gaps or overlaps.",
    appliances: "EV charger, climate appliance, and generic appliance editing are supported directly. Unsupported future appliance kinds are preserved and shown read-only unless you remove them.",
    generic_appliance_projection: "Configure the fixed average hourly energy in kWh. When history average is selected, Helman estimates the average hourly energy while the switch was on and falls back to the fixed value if history is insufficient.",
    climate_appliance_projection: "Configure the fixed average hourly energy in kWh. When history average is selected, Helman estimates the average hourly energy while the climate entity was active in heat or cool mode and falls back to the fixed value if history is insufficient."
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
    appliance_icon: "Appliance icon",
    kind: "Kind",
    climate_entity: "Climate entity",
    switch_entity: "Switch entity",
    projection_strategy: "Projection strategy",
    hourly_energy_kwh: "Average hourly energy kWh",
    history_energy_entity: "History energy entity",
    history_lookback_days: "History lookback days",
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
    mode_entity: "Helman writes schedule action options to this entity.",
    appliance_icon: "Optional. Leave empty to use the default energy icon in appliance metadata.",
    history_energy_entity: "Use a cumulative energy sensor that tracks the appliance energy consumption."
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
    fixed: "Fixed",
    history_average: "History average",
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
    climate_appliance: "Climate appliance {index}",
    generic_appliance: "Generic appliance {index}",
    vehicle: "Vehicle {index}",
    unsupported_appliance_kind: "Unsupported appliance kind: {kind}"
  },
  help: {
    aria_label: "Field help",
    close: "Close",
    history_buckets: "Number of history slots Helman keeps in storage for the UI history chart. Each slot covers one bucket-duration period. If not set, a built-in default is used.",
    history_bucket_duration: "Duration of a single history bucket in hours. Determines how fine-grained the UI history chart is. If not set, a built-in default is used.",
    power_sensor_name_cleaner_regex: "Optional regular expression applied when normalizing power sensor display names in the UI. Useful for stripping common prefixes or suffixes from entity names.",
    house_power_entity: "Real-time power consumption sensor for the whole house (W). Required for live power monitoring on the dashboard. Without it, house power data is not available.",
    house_forecast_total_energy_entity: "Cumulative (ever-increasing) energy sensor that tracks total house electricity consumption in kWh. Helman queries its long-term history from the HA Recorder to train the consumption forecast model. Without it, the house consumption forecast is completely disabled.",
    house_min_history_days: "Minimum number of days of recorded history required before the consumption forecast is considered valid. If the entity has fewer days of history, the forecast reports insufficient data. Defaults to 14 days if not set.",
    house_training_window_days: "How many past days Helman uses to train the consumption forecast model. A larger window produces more stable patterns but reacts more slowly to lifestyle changes. Defaults to 56 days if not set.",
    solar_power_entity: "Real-time solar panel output sensor (W). Used for live solar monitoring on the dashboard. Optional — solar power is not tracked without it.",
    solar_today_energy_entity: "Daily-resetting solar energy sensor (kWh produced today). Used as a fallback source for today's actual solar production overlay on the chart when the total energy entity is not configured.",
    solar_remaining_today_energy_forecast: "Entity that provides the forecast of remaining solar energy expected for the rest of today (kWh). Shown on the dashboard to indicate expected remaining generation.",
    solar_forecast_total_energy_entity: "Cumulative solar energy sensor (kWh, ever-increasing). Primary source for building the actual production history overlay on the solar forecast chart. Falls back to the today energy entity if not set.",
    solar_daily_energy_entity: "Entity from an external solar forecast provider (e.g. Forecast.Solar) that reports predicted daily energy in kWh. Helman uses these entities to build the solar generation forecast. Add one entity per forecast source.",
    battery_power_entity: "Real-time battery charge/discharge power sensor (W, positive = charging, negative = discharging). Used for live battery monitoring. Optional — battery power is not tracked without it.",
    battery_remaining_energy_entity: "Sensor reporting the current battery remaining energy in kWh. Together with the capacity entity, it enables battery state of charge calculation and forecast. Part of the battery entity group.",
    battery_capacity_entity: "Sensor reporting the total usable battery capacity in kWh. Used to calculate state of charge percentage. Part of the battery entity group.",
    battery_min_soc_entity: "Sensor or number entity reporting the minimum allowed state of charge (%). Helman will not schedule discharging below this level. Part of the battery entity group.",
    battery_max_soc_entity: "Sensor or number entity reporting the maximum allowed state of charge (%). Helman will not schedule charging above this level. Part of the battery entity group.",
    battery_charge_efficiency: "Battery charge round-trip efficiency as a decimal between 0 and 1 (e.g. 0.95 = 95%). Energy stored ÷ energy drawn from the grid. Used by the battery optimizer to accurately model charging costs. Defaults to 0.95 if not set.",
    battery_discharge_efficiency: "Battery discharge round-trip efficiency as a decimal between 0 and 1 (e.g. 0.95 = 95%). Energy delivered ÷ energy stored. Used by the optimizer to model discharge revenue. Defaults to 0.95 if not set.",
    battery_max_charge_power_w: "Maximum battery charge power in watts. Used to model charging speed and duration in the schedule optimizer. Without it, the optimizer cannot accurately estimate charging windows.",
    battery_max_discharge_power_w: "Maximum battery discharge power in watts. Used to model discharge speed and duration in the schedule optimizer. Without it, the optimizer cannot accurately estimate discharge windows.",
    grid_power_entity: "Real-time grid import/export power sensor (W, positive = importing, negative = exporting). Used for live grid monitoring on the dashboard. Optional — grid power is not tracked without it.",
    grid_sell_price_entity: "Entity providing the current grid electricity sell/export price. Used by the battery optimizer to evaluate whether discharging energy to the grid is profitable at a given time. Without it, sell price is treated as zero.",
    grid_import_price_unit: "Unit string shown next to import prices in the dashboard (e.g. CZK/kWh, EUR/kWh). Purely cosmetic — does not affect calculations.",
    import_window_start: "Start time of this import price window in local time (HH:MM). Import price windows must together cover the full 24-hour day without gaps or overlaps.",
    import_window_end: "End time of this import price window in local time (HH:MM). Use 00:00 to indicate midnight end-of-day.",
    import_window_price: "Import electricity price during this time window, in the unit configured above. Used by the battery optimizer to find the cheapest times to charge.",
    scheduler_mode_entity: "Input select or select entity that Helman writes schedule action commands to. Helman sets the option value that corresponds to the desired battery mode (charge, discharge, normal, etc.). Required for the scheduler to actually control the battery.",
    scheduler_action_option: "The option value that Helman will write to the mode entity when this action is scheduled. Must exactly match one of the options in the select entity. Leave empty if this action is not supported by your inverter.",
    deferrable_consumer_energy_entity: "Cumulative energy sensor (kWh) that tracks this appliance's total electricity consumption. Helman uses its recorded history to estimate how much energy this appliance will consume in upcoming time slots, so it can be deferred to cheaper periods.",
    appliance_id: "Unique internal identifier for this appliance. Used in automation references and schedule tracking. Should not be changed after the appliance is configured, as it may break existing automations.",
    appliance_name: "Display name shown for this appliance in the Helman dashboard and energy breakdowns.",
    ev_max_charging_power_kw: "Maximum charging power of the EV charger in kW. Used by the optimizer to model how quickly the vehicle can be charged and to plan charging windows accordingly.",
    ev_charge_switch_entity: "Switch entity that physically enables or disables EV charging. Helman turns this on or off to implement the charging schedule. Must be the actual control switch of your charger.",
    ev_use_mode_entity: "Select or input_select entity that controls the EV charger's operating mode (e.g. fixed max power, surplus aware). Helman writes the active mode to this entity to implement the scheduled charging behavior.",
    ev_eco_gear_entity: "Select or input_select entity that controls the eco gear level (charging power step) of the EV charger. Helman controls this in surplus-aware mode to throttle charging to available solar surplus.",
    appliance_climate_entity: "Climate entity for this appliance. Helman monitors its active/inactive state (heat or cool mode) to build history-based energy projections. Required for the history_average projection strategy.",
    appliance_switch_entity: "Switch entity that controls this generic appliance. Helman monitors the on/off state history to build energy projections when using the history_average strategy.",
    appliance_projection_strategy: "How Helman estimates this appliance's future energy consumption. Fixed: always uses the configured average hourly energy. History average: learns from the entity's recorded history and falls back to the fixed value if history is insufficient.",
    appliance_hourly_energy_kwh: "Average energy consumption per hour in kWh when the appliance is active. Used directly for the fixed strategy and as a fallback value for history_average when recorded history is insufficient.",
    appliance_history_lookback_days: "How many days back Helman looks when calculating the historical average energy consumption for this appliance. A longer lookback gives more stable estimates but reacts slower to changes in usage patterns.",
    vehicle_id: "Unique internal identifier for this vehicle. Used for tracking charge targets and schedule assignments. Should not be changed after the vehicle is configured.",
    vehicle_soc_entity: "Sensor reporting the vehicle's current battery state of charge as a percentage (0–100). Required for vehicle-aware charging scheduling — Helman uses it to determine how much charging is needed.",
    vehicle_charge_limit_entity: "Number entity reporting the vehicle's configured charge limit as a percentage (0–100). When provided, Helman uses it as the target SoC instead of assuming 100%. Optional.",
    vehicle_battery_capacity_kwh: "Total usable battery capacity of the vehicle in kWh. Required for accurate charge target and duration calculations.",
    vehicle_max_charging_power_kw: "Maximum AC charging power for this vehicle in kW. Used to model how quickly the vehicle charges and to plan charging window durations."
  }
}, ei = {
  editor: it
}, ti = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: ei,
  editor: it
}, Symbol.toStringTag, { value: "Module" })), ne = {
  cs: Xt,
  en: ti
};
function Fe(r) {
  var t;
  const e = oi((r == null ? void 0 : r.language) || ((t = r == null ? void 0 : r.locale) == null ? void 0 : t.language) || "cs");
  return (i) => ii(i, e);
}
function ii(r, e = "cs") {
  const t = e.replace(/['"]+/g, "").replace("_", "-");
  let i;
  try {
    i = r.split(".").reduce((o, a) => o[a], ne[t]);
  } catch {
    try {
      i = r.split(".").reduce((a, n) => a[n], ne.cs);
    } catch {
      i = r;
    }
  }
  if (i === void 0)
    try {
      i = r.split(".").reduce((o, a) => o[a], ne.cs);
    } catch {
      i = r;
    }
  return i;
}
function oi(r) {
  return r ? r.substring(0, 2) : "cs";
}
const Ne = [
  "ha-entity-picker",
  "ha-form",
  "ha-formfield",
  "ha-switch"
], Le = "ha-yaml-editor";
let D = null, Y = null;
const ri = async () => {
  if (!Ne.every((r) => customElements.get(r))) {
    if (D)
      return D;
    D = (async () => {
      await customElements.whenDefined("partial-panel-resolver");
      const r = document.createElement(
        "partial-panel-resolver"
      );
      r.hass = {
        panels: [
          {
            url_path: "tmp",
            component_name: "config"
          }
        ]
      }, r._updateRoutes(), await r.routerOptions.routes.tmp.load(), await customElements.whenDefined("ha-panel-config"), await document.createElement("ha-panel-config").routerOptions.routes.automation.load(), await Promise.all(Ne.map((t) => customElements.whenDefined(t)));
    })();
    try {
      await D;
    } catch (r) {
      throw D = null, r;
    }
  }
}, ai = async () => {
  if (!customElements.get(Le)) {
    if (Y)
      return Y;
    Y = (async () => {
      var i, o, a, n, s, l, c;
      await customElements.whenDefined("partial-panel-resolver"), await ((a = (o = (i = document.createElement(
        "partial-panel-resolver"
      ).getRoutes([
        {
          component_name: "developer-tools",
          url_path: "tmp"
        }
      ]).routes) == null ? void 0 : i.tmp) == null ? void 0 : o.load) == null ? void 0 : a.call(o)), await customElements.whenDefined("developer-tools-router"), await ((c = (l = (s = (n = document.createElement(
        "developer-tools-router"
      ).routerOptions) == null ? void 0 : n.routes) == null ? void 0 : s.service) == null ? void 0 : l.load) == null ? void 0 : c.call(l)), await customElements.whenDefined(Le);
    })();
    try {
      await Y;
    } catch (r) {
      throw Y = null, r;
    }
  }
}, se = "YAML must resolve to JSON-compatible scalars, arrays, and objects.";
function ni(r) {
  try {
    return {
      ok: !0,
      value: ce(r)
    };
  } catch {
    return { ok: !1, code: "non_json_value" };
  }
}
function ce(r) {
  if (r === null)
    return null;
  if (typeof r == "string" || typeof r == "boolean")
    return r;
  if (typeof r == "number") {
    if (!Number.isFinite(r))
      throw new Error(se);
    return r;
  }
  if (Array.isArray(r))
    return r.map((e) => ce(e));
  if (typeof r == "object") {
    const e = Object.getPrototypeOf(r);
    if (e !== Object.prototype && e !== null)
      throw new Error(se);
    const t = {};
    for (const [i, o] of Object.entries(r))
      t[i] = ce(o);
    return t;
  }
  throw new Error(se);
}
const si = [
  { value: "fixed_max_power", labelKey: "editor.values.fixed_max_power" },
  { value: "surplus_aware", labelKey: "editor.values.surplus_aware" }
], li = [
  { value: "fixed", labelKey: "editor.values.fixed" },
  { value: "history_average", labelKey: "editor.values.history_average" }
], di = {
  icon: {}
}, ee = class ee extends q {
  constructor() {
    super(...arguments), this._fallbackLocalize = Fe(), this._activeTab = "general", this._config = null, this._dirty = !1, this._loading = !1, this._saving = !1, this._validating = !1, this._validation = null, this._message = null, this._hasLoadedOnce = !1, this._scopeModes = {}, this._scopeYamlValues = {}, this._scopeYamlErrors = {}, this._helpDialog = null, this._preventSummaryToggle = (e) => {
      e.preventDefault(), e.stopPropagation();
    }, this._closeHelp = () => {
      this._helpDialog = null;
    }, this._handleReloadClick = async () => {
      (this._dirty || this._hasBlockingYamlErrors()) && !window.confirm(this._t("editor.confirm.discard_changes")) || await this._loadConfig({ showMessage: !0 });
    }, this._handleValidateClick = async () => {
      await this._validateConfig();
    }, this._handleSaveClick = async () => {
      await this._saveConfig();
    }, this._handleAddDeviceLabelCategory = () => {
      const e = A(this._getValue(["device_label_text"])).map(
        ([i]) => i
      ), t = Vt(e);
      this._applyMutation((i) => {
        m(i, ["device_label_text", t], {});
      });
    }, this._handleAddDeferrableConsumer = () => {
      var t;
      const e = ((t = b(
        this._getValue(["power_devices", "house", "forecast", "deferrable_consumers"])
      )) == null ? void 0 : t.length) ?? 0;
      this._applyMutation((i) => {
        O(
          i,
          ["power_devices", "house", "forecast", "deferrable_consumers"],
          Nt(
            this._tFormat("editor.dynamic.consumer", { index: e + 1 })
          )
        );
      });
    }, this._handleAddDailyEnergyEntity = () => {
      this._applyMutation((e) => {
        O(
          e,
          ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
          Dt()
        );
      });
    }, this._handleAddImportPriceWindow = () => {
      this._applyMutation((e) => {
        O(
          e,
          ["power_devices", "grid", "forecast", "import_price_windows"],
          Lt()
        );
      });
    }, this._handleAddEvCharger = () => {
      const e = (b(this._getValue(["appliances"])) ?? []).map((t) => {
        var i;
        return this._stringValue((i = v(t)) == null ? void 0 : i.id);
      }).filter((t) => t.length > 0);
      this._applyMutation((t) => {
        O(
          t,
          ["appliances"],
          Ht(
            e,
            this._tFormat("editor.dynamic.ev_charger", { index: e.length + 1 }),
            this._tFormat("editor.dynamic.vehicle", { index: 1 })
          )
        );
      });
    }, this._handleAddClimateAppliance = () => {
      const e = (b(this._getValue(["appliances"])) ?? []).map((t) => {
        var i;
        return this._stringValue((i = v(t)) == null ? void 0 : i.id);
      }).filter((t) => t.length > 0);
      this._applyMutation((t) => {
        O(
          t,
          ["appliances"],
          Rt(
            e,
            this._tFormat("editor.dynamic.climate_appliance", {
              index: e.length + 1
            })
          )
        );
      });
    }, this._handleAddGenericAppliance = () => {
      const e = (b(this._getValue(["appliances"])) ?? []).map((t) => {
        var i;
        return this._stringValue((i = v(t)) == null ? void 0 : i.id);
      }).filter((t) => t.length > 0);
      this._applyMutation((t) => {
        O(
          t,
          ["appliances"],
          It(
            e,
            this._tFormat("editor.dynamic.generic_appliance", {
              index: e.length + 1
            })
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
    super.connectedCallback(), ri().then(() => {
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
    return d`
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
          ${this._loading ? d`<span class="badge info">${this._t("editor.status.loading_config")}</span>` : p}
          ${this._dirty ? d`<span class="badge info">${this._t("editor.status.unsaved_changes")}</span>` : d`<span class="badge info">${this._t("editor.status.stored_config_loaded")}</span>`}
          ${!this._dirty && ((i = this._validation) != null && i.valid) ? d`<span class="badge info">${this._t("editor.status.last_validation_passed")}</span>` : p}
          ${this._dirty ? d`<span class="badge info">${this._t("editor.status.validation_stale")}</span>` : p}
          ${t ? d`<span class="badge info">${this._t("editor.status.fix_yaml_errors")}</span>` : p}
        </div>

        ${this._message ? d`<div class="message ${this._message.kind}">${this._message.text}</div>` : p}

        ${this._renderIssueBoard()}

        ${this._config ? this._renderDocumentBody(e) : p}
      </div>
      ${this._renderHelpDialog()}
    `;
  }
  _renderDocumentBody(e) {
    return this._isScopeYaml($) ? d`<div class="list-card">${this._renderYamlEditor($)}</div>` : d`
      <div class="tabs">
        ${Kt.map((t) => {
      const i = e[t.id];
      return d`
            <button
              type="button"
              class=${this._activeTab === t.id ? "active" : ""}
              @click=${() => {
        this._activeTab = t.id;
      }}
            >
              <span>${this._t(t.labelKey)}</span>
              ${i.errors > 0 ? d`<span class="tab-count errors">${i.errors}</span>` : i.warnings > 0 ? d`<span class="tab-count warnings">${i.warnings}</span>` : p}
            </button>
          `;
    })}
      </div>

      ${zt(this._renderActiveTab())}
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
        return d``;
    }
  }
  _renderTabScope(e, t) {
    return d`
      <div class="tab-scope">
        <div class="scope-toolbar">
          ${this._renderModeToggle(e)}
        </div>
        ${this._isScopeYaml(e) ? d`<div class="list-card">${this._renderYamlEditor(e)}</div>` : d`<div class="tab-body">${t}</div>`}
      </div>
    `;
  }
  _renderSectionScope(e, t) {
    const i = L(e);
    return d`
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
    return d`
      <div
        class="mode-toggle"
        @click=${t.inSummary ? this._preventSummaryToggle : void 0}
      >
        <button
          type="button"
          class=${i === "visual" ? "active" : ""}
          aria-pressed=${i === "visual"}
          @click=${(o) => this._handleScopeModeSelection(e, "visual", o)}
        >
          ${this._t("editor.mode.visual")}
        </button>
        <button
          type="button"
          class=${i === "yaml" ? "active" : ""}
          aria-pressed=${i === "yaml"}
          @click=${(o) => this._handleScopeModeSelection(e, "yaml", o)}
        >
          ${this._t("editor.mode.yaml")}
        </button>
      </div>
    `;
  }
  _renderYamlEditor(e) {
    const t = L(e), i = this._t(t.labelKey), o = t.kind === "document" ? "editor.yaml.helpers.document" : t.kind === "tab" ? "editor.yaml.helpers.tab" : "editor.yaml.helpers.section", a = this._scopeYamlErrors[e], n = this._scopeDomId(e), s = `${n}-yaml-helper`, l = `${n}-yaml-error`, c = a ? `${s} ${l}` : s, _ = this._scopeYamlValues[e] ?? t.adapter.read(this._config ?? {});
    return d`
      <div class="yaml-surface">
        <div
          class=${[
      "field",
      "yaml-field",
      t.kind === "document" ? "yaml-field--document" : ""
    ].filter((h) => h.length > 0).join(" ")}
        >
          <label>${this._t("editor.yaml.field_label")}</label>
          <div id=${s} class="helper">${this._t(o)}</div>
          <ha-yaml-editor
            .hass=${this.hass}
            .defaultValue=${_}
            .showErrors=${!1}
            aria-label=${this._tFormat("editor.yaml.aria_label", { scope: i })}
            aria-describedby=${c}
            dir="ltr"
            @value-changed=${(h) => this._handleYamlValueChanged(e, h)}
          ></ha-yaml-editor>
        </div>
        ${a ? d`
              <div id=${l} class="message error yaml-error">
                <div>${a}</div>
                <div class="helper">${this._t("editor.yaml.errors.fix_before_leaving")}</div>
              </div>
            ` : p}
      </div>
    `;
  }
  _renderGeneralTab() {
    return d`
      ${this._renderSectionScope(
      u.general.core_labels_and_history,
      d`
          <div class="field-grid">
            ${this._renderOptionalNumberField(
        ["history_buckets"],
        "editor.fields.history_buckets",
        "editor.helpers.history_buckets",
        "editor.help.history_buckets"
      )}
            ${this._renderOptionalNumberField(
        ["history_bucket_duration"],
        "editor.fields.history_bucket_duration",
        "editor.helpers.history_bucket_duration",
        "editor.help.history_bucket_duration"
      )}
            ${this._renderOptionalTextField(["sources_title"], "editor.fields.sources_title")}
            ${this._renderOptionalTextField(["consumers_title"], "editor.fields.consumers_title")}
            ${this._renderOptionalTextField(["groups_title"], "editor.fields.groups_title")}
            ${this._renderOptionalTextField(["others_group_label"], "editor.fields.others_group_label")}
            ${this._renderOptionalTextField(
        ["power_sensor_name_cleaner_regex"],
        "editor.fields.power_sensor_name_cleaner_regex",
        "editor.helpers.power_sensor_name_cleaner_regex",
        "editor.help.power_sensor_name_cleaner_regex"
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
      d`
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
    const e = b(this._getValue(["power_devices", "solar", "forecast", "daily_energy_entity_ids"])) ?? [], t = b(
      this._getValue(["power_devices", "house", "forecast", "deferrable_consumers"])
    ) ?? [], i = b(this._getValue(["power_devices", "grid", "forecast", "import_price_windows"])) ?? [];
    return d`
      ${this._renderSectionScope(
      u.power_devices.house,
      d`
          <div class="field-grid">
            ${this._renderRequiredEntityField(
        ["power_devices", "house", "entities", "power"],
        "editor.fields.house_power_entity",
        ["sensor"],
        void 0,
        void 0,
        "editor.help.house_power_entity"
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
        ["sensor"],
        void 0,
        "editor.help.house_forecast_total_energy_entity"
      )}
            ${this._renderOptionalNumberField(
        ["power_devices", "house", "forecast", "min_history_days"],
        "editor.fields.min_history_days",
        void 0,
        "editor.help.house_min_history_days"
      )}
            ${this._renderOptionalNumberField(
        ["power_devices", "house", "forecast", "training_window_days"],
        "editor.fields.training_window_days",
        void 0,
        "editor.help.house_training_window_days"
      )}
          </div>

          <div class="list-stack">
            ${t.map(
        (o, a) => this._renderDeferrableConsumer(o, a, t.length)
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
      d`
          <div class="field-grid field-grid--roomy">
            ${this._renderOptionalEntityField(
        ["power_devices", "solar", "entities", "power"],
        "editor.fields.power_entity",
        ["sensor"],
        void 0,
        "editor.help.solar_power_entity"
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "solar", "entities", "today_energy"],
        "editor.fields.today_energy_entity",
        ["sensor"],
        void 0,
        "editor.help.solar_today_energy_entity"
      )}
            ${this._renderOptionalEntityField(
        [
          "power_devices",
          "solar",
          "entities",
          "remaining_today_energy_forecast"
        ],
        "editor.fields.remaining_today_energy_forecast",
        ["sensor"],
        void 0,
        "editor.help.solar_remaining_today_energy_forecast"
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "solar", "forecast", "total_energy_entity_id"],
        "editor.fields.forecast_total_energy_entity",
        ["sensor"],
        void 0,
        "editor.help.solar_forecast_total_energy_entity"
      )}
          </div>

          <div class="list-stack">
            ${e.map(
        (o, a) => this._renderDailyEnergyEntity(o, a, e.length)
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
      d`
          <p class="inline-note">
            ${this._t("editor.notes.battery_entities")}
          </p>
          <div class="field-grid field-grid--roomy">
            ${this._renderOptionalEntityField(
        ["power_devices", "battery", "entities", "power"],
        "editor.fields.power_entity",
        ["sensor"],
        void 0,
        "editor.help.battery_power_entity"
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "battery", "entities", "remaining_energy"],
        "editor.fields.remaining_energy_entity",
        ["sensor"],
        void 0,
        "editor.help.battery_remaining_energy_entity"
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "battery", "entities", "capacity"],
        "editor.fields.capacity_entity",
        ["sensor"],
        void 0,
        "editor.help.battery_capacity_entity"
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "battery", "entities", "min_soc"],
        "editor.fields.min_soc_entity",
        ["sensor"],
        void 0,
        "editor.help.battery_min_soc_entity"
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "battery", "entities", "max_soc"],
        "editor.fields.max_soc_entity",
        ["sensor"],
        void 0,
        "editor.help.battery_max_soc_entity"
      )}
          </div>
          <div class="field-grid">
            ${this._renderOptionalNumberField(
        ["power_devices", "battery", "forecast", "charge_efficiency"],
        "editor.fields.charge_efficiency",
        void 0,
        "editor.help.battery_charge_efficiency"
      )}
            ${this._renderOptionalNumberField(
        ["power_devices", "battery", "forecast", "discharge_efficiency"],
        "editor.fields.discharge_efficiency",
        void 0,
        "editor.help.battery_discharge_efficiency"
      )}
            ${this._renderOptionalNumberField(
        ["power_devices", "battery", "forecast", "max_charge_power_w"],
        "editor.fields.max_charge_power_w",
        void 0,
        "editor.help.battery_max_charge_power_w"
      )}
            ${this._renderOptionalNumberField(
        ["power_devices", "battery", "forecast", "max_discharge_power_w"],
        "editor.fields.max_discharge_power_w",
        void 0,
        "editor.help.battery_max_discharge_power_w"
      )}
          </div>
        `
    )}

      ${this._renderSectionScope(
      u.power_devices.grid,
      d`
          <div class="field-grid">
            ${this._renderOptionalEntityField(
        ["power_devices", "grid", "entities", "power"],
        "editor.fields.power_entity",
        ["sensor"],
        void 0,
        "editor.help.grid_power_entity"
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "grid", "forecast", "sell_price_entity_id"],
        "editor.fields.sell_price_entity",
        ["sensor"],
        void 0,
        "editor.help.grid_sell_price_entity"
      )}
            ${this._renderOptionalTextField(
        ["power_devices", "grid", "forecast", "import_price_unit"],
        "editor.fields.import_price_unit",
        "editor.helpers.import_price_unit",
        "editor.help.grid_import_price_unit"
      )}
          </div>

          <p class="inline-note">
            ${this._t("editor.notes.grid_import_windows")}
          </p>
          <div class="list-stack">
            ${i.map(
        (o, a) => this._renderImportPriceWindow(o, a, i.length)
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
    return d`
      ${this._renderSectionScope(
      u.scheduler.schedule_control_mapping,
      d`
          <div class="field-grid">
            ${this._renderRequiredEntityField(
        ["scheduler", "control", "mode_entity_id"],
        "editor.fields.mode_entity",
        ["input_select", "select"],
        "editor.helpers.mode_entity",
        void 0,
        "editor.help.scheduler_mode_entity"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "normal"],
        "editor.fields.normal_option",
        void 0,
        "editor.help.scheduler_action_option"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "charge_to_target_soc"],
        "editor.fields.charge_to_target_soc_option",
        void 0,
        "editor.help.scheduler_action_option"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "discharge_to_target_soc"],
        "editor.fields.discharge_to_target_soc_option",
        void 0,
        "editor.help.scheduler_action_option"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "stop_charging"],
        "editor.fields.stop_charging_option",
        void 0,
        "editor.help.scheduler_action_option"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "stop_discharging"],
        "editor.fields.stop_discharging_option",
        void 0,
        "editor.help.scheduler_action_option"
      )}
          </div>
        `
    )}
    `;
  }
  _renderAppliancesTab() {
    const e = b(this._getValue(["appliances"])) ?? [];
    return d`
      ${this._renderSectionScope(
      u.appliances.configured_appliances,
      d`
          <p class="inline-note">
            ${this._t("editor.notes.appliances")}
          </p>
          <div class="list-stack">
            ${e.length === 0 ? d`<div class="message info">${this._t("editor.empty.no_appliances")}</div>` : e.map(
        (t, i) => this._renderApplianceCard(t, i, e.length)
      )}
          </div>
          <div class="section-footer">
            <button type="button" class="add-button primary" @click=${this._handleAddEvCharger}>
              ${this._t("editor.actions.add_ev_charger")}
            </button>
            <button
              type="button"
              class="add-button"
              @click=${this._handleAddClimateAppliance}
            >
              ${this._t("editor.actions.add_climate_appliance")}
            </button>
            <button
              type="button"
              class="add-button"
              @click=${this._handleAddGenericAppliance}
            >
              ${this._t("editor.actions.add_generic_appliance")}
            </button>
          </div>
        `
    )}
    `;
  }
  _renderDeviceLabelCategories() {
    const e = A(this._getValue(["device_label_text"]));
    return e.length === 0 ? [d`<div class="message info">${this._t("editor.empty.no_device_label_categories")}</div>`] : e.map(([t, i]) => {
      const o = A(i);
      return d`
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
                @change=${(a) => {
        this._handleRenameObjectKey(
          ["device_label_text"],
          t,
          a.currentTarget.value
        );
      }}
              />
            </div>
          </div>
          <div class="list-stack">
            ${o.map(([a, n]) => d`
              <div class="nested-card">
                <div class="card-header">
                  <div class="card-title">
                    <strong>${a}</strong>
                    <span class="card-subtitle">${this._t("editor.card.badge_text_entry")}</span>
                  </div>
                  <div class="inline-actions">
                    <button
                      type="button"
                      class="danger"
                      @click=${() => this._removePath(["device_label_text", t, a])}
                    >
                      ${this._t("editor.actions.remove")}
                    </button>
                  </div>
                </div>
                <div class="field-grid">
                  <div class="field">
                    <label>${this._t("editor.fields.label_key")}</label>
                    <input
                      .value=${a}
                      @change=${(s) => {
        this._handleRenameObjectKey(
          ["device_label_text", t],
          a,
          s.currentTarget.value
        );
      }}
                    />
                  </div>
                  <div class="field">
                    <label>${this._t("editor.fields.badge_text")}</label>
                    <input
                      .value=${this._stringValue(n)}
                      @change=${(s) => {
        this._setRequiredString(
          ["device_label_text", t, a],
          s.currentTarget.value
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
    const o = v(e) ?? {}, a = [
      "power_devices",
      "house",
      "forecast",
      "deferrable_consumers",
      t
    ];
    return d`
      <div class="list-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${this._stringValue(o.label) || this._tFormat("editor.dynamic.consumer", { index: t + 1 })}</strong>
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
      [...a, "energy_entity_id"],
      "editor.fields.energy_entity",
      ["sensor"],
      void 0,
      void 0,
      "editor.help.deferrable_consumer_energy_entity"
    )}
          ${this._renderOptionalTextField([...a, "label"], "editor.fields.label")}
        </div>
      </div>
    `;
  }
  _renderDailyEnergyEntity(e, t, i) {
    const o = [
      "power_devices",
      "solar",
      "forecast",
      "daily_energy_entity_ids",
      t
    ];
    return d`
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
        ${this._renderRequiredEntityField(o, "editor.fields.entity_id", ["sensor"], void 0, e, "editor.help.solar_daily_energy_entity")}
      </div>
    `;
  }
  _renderImportPriceWindow(e, t, i) {
    const o = v(e) ?? {}, a = [
      "power_devices",
      "grid",
      "forecast",
      "import_price_windows",
      t
    ];
    return d`
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
            <div class="field-label-row">
              <label>${this._t("editor.fields.start")}</label>
              ${this._renderHelpIcon("editor.fields.start", "editor.help.import_window_start")}
            </div>
            <input
              type="time"
              .value=${this._stringValue(o.start)}
              @change=${(n) => this._setRequiredString(
      [...a, "start"],
      n.currentTarget.value
    )}
            />
          </div>
          <div class="field">
            <div class="field-label-row">
              <label>${this._t("editor.fields.end")}</label>
              ${this._renderHelpIcon("editor.fields.end", "editor.help.import_window_end")}
            </div>
            <input
              type="time"
              .value=${this._stringValue(o.end)}
              @change=${(n) => this._setRequiredString(
      [...a, "end"],
      n.currentTarget.value
    )}
            />
          </div>
          ${this._renderRequiredNumberField([...a, "price"], "editor.fields.price", void 0, "any", "editor.help.import_window_price")}
        </div>
      </div>
    `;
  }
  _renderApplianceCard(e, t, i) {
    const o = v(e) ?? {}, a = this._stringValue(o.kind);
    return a === "ev_charger" ? this._renderEvChargerAppliance(o, t, i) : a === "climate" ? this._renderClimateAppliance(o, t, i) : a === "generic" ? this._renderGenericAppliance(o, t, i) : this._renderUnsupportedAppliance(o, t, i);
  }
  _renderUnsupportedAppliance(e, t, i) {
    return d`
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
    const o = ["appliances", t], a = A(
      this._getValue([...o, "controls", "use_mode", "values"])
    ), n = A(
      this._getValue([...o, "controls", "eco_gear", "values"])
    ), s = b(this._getValue([...o, "vehicles"])) ?? [], l = this._stringValue(e.name) || this._tFormat("editor.dynamic.ev_charger", { index: t + 1 }), c = this._stringValue(e.id) || this._t("editor.values.missing_id");
    return d`
      <div class="list-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${l}</strong>
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
              ${this._renderRequiredTextField([...o, "id"], "editor.fields.appliance_id", void 0, "editor.help.appliance_id")}
              ${this._renderRequiredTextField([...o, "name"], "editor.fields.appliance_name", void 0, "editor.help.appliance_name")}
              ${this._renderOptionalIconField(
      [...o, "icon"],
      "editor.fields.appliance_icon",
      "editor.helpers.appliance_icon"
    )}
              <div class="field">
                <label>${this._t("editor.fields.kind")}</label>
                <input value="ev_charger" disabled />
              </div>
              ${this._renderRequiredNumberField(
      [...o, "limits", "max_charging_power_kw"],
      "editor.fields.max_charging_power_kw",
      void 0,
      "any",
      "editor.help.ev_max_charging_power_kw"
    )}
            </div>
          </div>
        </details>

        <details class="section-card" open>
          <summary>${this._t("editor.sections.controls")}</summary>
          <div class="section-content">
            <div class="field-grid">
              ${this._renderRequiredEntityField(
      [...o, "controls", "charge", "entity_id"],
      "editor.fields.charge_switch_entity",
      ["switch"],
      void 0,
      void 0,
      "editor.help.ev_charge_switch_entity"
    )}
              ${this._renderRequiredEntityField(
      [...o, "controls", "use_mode", "entity_id"],
      "editor.fields.use_mode_entity",
      ["input_select", "select"],
      void 0,
      void 0,
      "editor.help.ev_use_mode_entity"
    )}
              ${this._renderRequiredEntityField(
      [...o, "controls", "eco_gear", "entity_id"],
      "editor.fields.eco_gear_entity",
      ["input_select", "select"],
      void 0,
      void 0,
      "editor.help.ev_eco_gear_entity"
    )}
            </div>
          </div>
        </details>

        <details class="section-card" open>
          <summary>${this._t("editor.sections.use_modes")}</summary>
          <div class="section-content">
            <div class="list-stack">
              ${a.map(
      ([_, h]) => this._renderUseMode(o, _, h)
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
              ${n.map(
      ([_, h]) => this._renderEcoGear(o, _, h)
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
              ${s.map(
      (_, h) => this._renderVehicle(o, _, h, s.length)
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
  _renderGenericAppliance(e, t, i) {
    const o = ["appliances", t], a = [...o, "projection", "history_average"], n = this._stringValue(this._getValue([...o, "projection", "strategy"])) || "fixed", s = this._stringValue(e.name) || this._tFormat("editor.dynamic.generic_appliance", { index: t + 1 }), l = this._stringValue(e.id) || this._t("editor.values.missing_id");
    return d`
      <div class="list-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${s}</strong>
            <span class="card-subtitle">${l}</span>
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
              ${this._renderRequiredTextField([...o, "id"], "editor.fields.appliance_id", void 0, "editor.help.appliance_id")}
              ${this._renderRequiredTextField([...o, "name"], "editor.fields.appliance_name", void 0, "editor.help.appliance_name")}
              ${this._renderOptionalIconField(
      [...o, "icon"],
      "editor.fields.appliance_icon",
      "editor.helpers.appliance_icon"
    )}
              <div class="field">
                <label>${this._t("editor.fields.kind")}</label>
                <input value="generic" disabled />
              </div>
            </div>
          </div>
        </details>

        <details class="section-card" open>
          <summary>${this._t("editor.sections.controls")}</summary>
          <div class="section-content">
            <div class="field-grid">
              ${this._renderRequiredEntityField(
      [...o, "controls", "switch", "entity_id"],
      "editor.fields.switch_entity",
      ["switch"],
      void 0,
      void 0,
      "editor.help.appliance_switch_entity"
    )}
            </div>
          </div>
        </details>

        <details class="section-card" open>
          <summary>${this._t("editor.sections.projection")}</summary>
          ${this._renderProjectedApplianceProjectionSection(
      o,
      n,
      a,
      "editor.notes.generic_appliance_projection",
      (c) => this._handleProjectedApplianceProjectionStrategyChange(t, c)
    )}
        </details>
      </div>
    `;
  }
  _renderClimateAppliance(e, t, i) {
    const o = ["appliances", t], a = [...o, "projection", "history_average"], n = this._stringValue(this._getValue([...o, "projection", "strategy"])) || "fixed", s = this._stringValue(e.name) || this._tFormat("editor.dynamic.climate_appliance", { index: t + 1 }), l = this._stringValue(e.id) || this._t("editor.values.missing_id");
    return d`
      <div class="list-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${s}</strong>
            <span class="card-subtitle">${l}</span>
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
              ${this._renderRequiredTextField([...o, "id"], "editor.fields.appliance_id", void 0, "editor.help.appliance_id")}
              ${this._renderRequiredTextField([...o, "name"], "editor.fields.appliance_name", void 0, "editor.help.appliance_name")}
              ${this._renderOptionalIconField(
      [...o, "icon"],
      "editor.fields.appliance_icon",
      "editor.helpers.appliance_icon"
    )}
              <div class="field">
                <label>${this._t("editor.fields.kind")}</label>
                <input value="climate" disabled />
              </div>
            </div>
          </div>
        </details>

        <details class="section-card" open>
          <summary>${this._t("editor.sections.controls")}</summary>
          <div class="section-content">
            <div class="field-grid">
              ${this._renderRequiredEntityField(
      [...o, "controls", "climate", "entity_id"],
      "editor.fields.climate_entity",
      ["climate"],
      void 0,
      void 0,
      "editor.help.appliance_climate_entity"
    )}
            </div>
          </div>
        </details>

        <details class="section-card" open>
          <summary>${this._t("editor.sections.projection")}</summary>
          ${this._renderProjectedApplianceProjectionSection(
      o,
      n,
      a,
      "editor.notes.climate_appliance_projection",
      (c) => this._handleProjectedApplianceProjectionStrategyChange(t, c)
    )}
        </details>
      </div>
    `;
  }
  _renderProjectedApplianceProjectionSection(e, t, i, o, a) {
    return d`
      <div class="section-content">
        <p class="inline-note">
          ${this._t(o)}
        </p>
        <div class="field-grid">
          <div class="field">
            <div class="field-label-row">
              <label>${this._t("editor.fields.projection_strategy")}</label>
              ${this._renderHelpIcon("editor.fields.projection_strategy", "editor.help.appliance_projection_strategy")}
            </div>
            <select
              .value=${t}
              @change=${(n) => a(n.currentTarget.value)}
            >
              ${li.map(
      (n) => d`
                  <option value=${n.value}>${this._t(n.labelKey)}</option>
                `
    )}
            </select>
          </div>
          ${this._renderRequiredNumberField(
      [...e, "projection", "hourly_energy_kwh"],
      "editor.fields.hourly_energy_kwh",
      void 0,
      "any",
      "editor.help.appliance_hourly_energy_kwh"
    )}
        </div>
        ${t === "history_average" ? d`
              <div class="field-grid">
                ${this._renderRequiredEntityField(
      [...i, "energy_entity_id"],
      "editor.fields.history_energy_entity",
      ["sensor"],
      "editor.helpers.history_energy_entity"
    )}
                ${this._renderRequiredNumberField(
      [...i, "lookback_days"],
      "editor.fields.history_lookback_days",
      void 0,
      "1",
      "editor.help.appliance_history_lookback_days"
    )}
              </div>
            ` : p}
      </div>
    `;
  }
  _renderUseMode(e, t, i) {
    const o = v(i) ?? {}, a = [
      ...e,
      "controls",
      "use_mode",
      "values"
    ];
    return d`
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
              @click=${() => this._removePath([...a, t])}
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
              @change=${(n) => this._handleRenameObjectKey(
      a,
      t,
      n.currentTarget.value
    )}
            />
          </div>
          <div class="field">
            <label>${this._t("editor.fields.behavior")}</label>
            <select
              .value=${this._stringValue(o.behavior) || "fixed_max_power"}
              @change=${(n) => this._setRequiredString(
      [...a, t, "behavior"],
      n.currentTarget.value
    )}
            >
              ${si.map(
      (n) => d`
                  <option value=${n.value}>${this._t(n.labelKey)}</option>
                `
    )}
            </select>
          </div>
        </div>
      </div>
    `;
  }
  _renderEcoGear(e, t, i) {
    const o = v(i) ?? {}, a = [
      ...e,
      "controls",
      "eco_gear",
      "values"
    ];
    return d`
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
              @click=${() => this._removePath([...a, t])}
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
              @change=${(n) => this._handleRenameObjectKey(
      a,
      t,
      n.currentTarget.value
    )}
            />
          </div>
          ${this._renderRequiredNumberField(
      [...a, t, "min_power_kw"],
      "editor.fields.min_power_kw",
      o.min_power_kw
    )}
        </div>
      </div>
    `;
  }
  _renderVehicle(e, t, i, o) {
    const a = v(t) ?? {}, n = [...e, "vehicles", i];
    return d`
      <div class="nested-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${this._stringValue(a.name) || this._tFormat("editor.dynamic.vehicle", { index: i + 1 })}</strong>
            <span class="card-subtitle">${this._stringValue(a.id) || this._t("editor.values.missing_id")}</span>
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
              ?disabled=${i === o - 1}
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
          ${this._renderRequiredTextField([...n, "id"], "editor.fields.vehicle_id", void 0, "editor.help.vehicle_id")}
          ${this._renderRequiredTextField([...n, "name"], "editor.fields.vehicle_name")}
          ${this._renderRequiredEntityField(
      [...n, "telemetry", "soc_entity_id"],
      "editor.fields.soc_entity",
      ["sensor"],
      void 0,
      void 0,
      "editor.help.vehicle_soc_entity"
    )}
          ${this._renderOptionalEntityField(
      [...n, "telemetry", "charge_limit_entity_id"],
      "editor.fields.charge_limit_entity",
      ["number"],
      void 0,
      "editor.help.vehicle_charge_limit_entity"
    )}
          ${this._renderRequiredNumberField(
      [...n, "limits", "battery_capacity_kwh"],
      "editor.fields.battery_capacity_kwh",
      void 0,
      "any",
      "editor.help.vehicle_battery_capacity_kwh"
    )}
          ${this._renderRequiredNumberField(
      [...n, "limits", "max_charging_power_kw"],
      "editor.fields.max_charging_power_kw",
      void 0,
      "any",
      "editor.help.vehicle_max_charging_power_kw"
    )}
        </div>
      </div>
    `;
  }
  _renderOptionalTextField(e, t, i, o) {
    return d`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(t)}</label>
          ${o ? this._renderHelpIcon(t, o) : p}
        </div>
        <input
          .value=${this._stringValue(this._getValue(e))}
          @change=${(a) => this._setOptionalString(e, a.currentTarget.value)}
        />
        ${i ? d`<div class="helper">${this._t(i)}</div>` : p}
      </div>
    `;
  }
  _renderRequiredTextField(e, t, i, o) {
    const a = i === void 0 ? this._getValue(e) : i;
    return d`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(t)}</label>
          ${o ? this._renderHelpIcon(t, o) : p}
        </div>
        <input
          .value=${this._stringValue(a)}
          @change=${(n) => this._setRequiredString(e, n.currentTarget.value)}
        />
      </div>
    `;
  }
  _renderOptionalNumberField(e, t, i, o) {
    return d`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(t)}</label>
          ${o ? this._renderHelpIcon(t, o) : p}
        </div>
        <input
          type="number"
          step="any"
          .value=${this._stringValue(this._getValue(e))}
          @change=${(a) => this._setOptionalNumber(e, a.currentTarget.value)}
        />
        ${i ? d`<div class="helper">${this._t(i)}</div>` : p}
      </div>
    `;
  }
  _renderRequiredNumberField(e, t, i, o = "any", a) {
    const n = i === void 0 ? this._getValue(e) : i;
    return d`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(t)}</label>
          ${a ? this._renderHelpIcon(t, a) : p}
        </div>
        <input
          type="number"
          .step=${o}
          .value=${this._stringValue(n)}
          @change=${(s) => this._setRequiredNumber(e, s.currentTarget.value)}
        />
      </div>
    `;
  }
  _renderOptionalIconField(e, t, i) {
    return d`
      <div class="field">
        <ha-selector
          .hass=${this.hass}
          .narrow=${this.narrow ?? !1}
          .selector=${di}
          .label=${this._t(t)}
          .helper=${i ? this._t(i) : void 0}
          .required=${!1}
          .value=${this._stringValue(this._getValue(e))}
          @value-changed=${(o) => {
      var n;
      const a = ((n = o.detail) == null ? void 0 : n.value) ?? "";
      this._setOptionalString(e, a);
    }}
        ></ha-selector>
      </div>
    `;
  }
  _renderBooleanField(e, t, i) {
    const o = this._booleanValue(this._getValue(e), i);
    return d`
      <div class="field toggle-field">
        <ha-formfield .label=${this._t(t)}>
          <ha-switch
            .checked=${o}
            @change=${(a) => this._setBoolean(
      e,
      a.currentTarget.checked
    )}
          ></ha-switch>
        </ha-formfield>
      </div>
    `;
  }
  _renderOptionalEntityField(e, t, i, o, a) {
    return this._renderEntityField(
      e,
      t,
      i,
      o,
      !1,
      this._getValue(e),
      a
    );
  }
  _renderRequiredEntityField(e, t, i, o, a, n) {
    return this._renderEntityField(
      e,
      t,
      i,
      o,
      !0,
      a === void 0 ? this._getValue(e) : a,
      n
    );
  }
  _renderEntityField(e, t, i, o, a, n, s) {
    return d`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(t)}</label>
          ${s ? this._renderHelpIcon(t, s) : p}
        </div>
        <ha-entity-picker
          .hass=${this.hass}
          .value=${this._stringValue(n)}
          .includeDomains=${i}
          @value-changed=${(l) => {
      var _;
      const c = ((_ = l.detail) == null ? void 0 : _.value) ?? "";
      a ? this._setRequiredString(e, c) : this._setOptionalString(e, c);
    }}
        ></ha-entity-picker>
        ${o ? d`<div class="helper">${this._t(o)}</div>` : p}
      </div>
    `;
  }
  _renderHelpIcon(e, t) {
    return d`
      <button
        type="button"
        class="help-btn"
        aria-label=${this._t("editor.help.aria_label")}
        @click=${(i) => {
      i.stopPropagation(), this._helpDialog = { labelKey: e, contentKey: t };
    }}
      >?</button>
    `;
  }
  _renderHelpDialog() {
    if (!this._helpDialog)
      return p;
    const { labelKey: e, contentKey: t } = this._helpDialog;
    return d`
      <div class="help-overlay" @click=${this._closeHelp}>
        <div class="help-dialog" @click=${(i) => i.stopPropagation()}>
          <div class="help-dialog-header">
            <strong>${this._t(e)}</strong>
            <button
              type="button"
              class="help-dialog-close"
              aria-label=${this._t("editor.help.close")}
              @click=${this._closeHelp}
            >✕</button>
          </div>
          <p class="help-dialog-body">${this._t(t)}</p>
        </div>
      </div>
    `;
  }
  _renderIssueBoard() {
    if (!this._validation)
      return p;
    const e = [
      { title: this._t("editor.issues.errors"), items: this._validation.errors },
      { title: this._t("editor.issues.warnings"), items: this._validation.warnings }
    ].filter((t) => t.items.length > 0);
    return e.length === 0 ? p : d`
      <div class="issue-board">
        ${e.map(
      (t) => d`
            <div class="issue-group">
              <h3>${t.title}</h3>
              <ul>
                ${t.items.map(
        (i) => d`
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
        const i = He[t.section] ?? "general";
        e[i].errors += 1;
      }
      for (const t of this._validation.warnings) {
        const i = He[t.section] ?? "general";
        e[i].warnings += 1;
      }
    }
    for (const t of Object.keys(this._scopeYamlErrors)) {
      if (!this._scopeYamlErrors[t])
        continue;
      const i = L(t).tabId;
      i && (e[i].warnings += 1);
    }
    return e;
  }
  async _loadConfig(e) {
    if (this.hass) {
      this._loading = !0;
      try {
        const t = await this.hass.callWS({ type: "helman/get_config" });
        this._config = v(t) ? y(t) : {}, this._validation = null, this._dirty = !1, this._resetScopeYamlState(), e.showMessage && (this._message = {
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
    const t = Te(e);
    try {
      if (await ai(), !this._config || this._isScopeYaml(e))
        return;
      const i = this._omitScopeIds(this._scopeModes, t);
      i[e] = "yaml";
      const o = this._omitScopeIds(
        this._scopeYamlValues,
        t
      );
      o[e] = L(e).adapter.read(this._config);
      const a = this._omitScopeIds(
        this._scopeYamlErrors,
        t
      );
      delete a[e], this._scopeModes = i, this._scopeYamlValues = o, this._scopeYamlErrors = a, this._message = null;
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
    const o = { ...this._scopeYamlErrors };
    delete o[e], this._scopeModes = t, this._scopeYamlValues = i, this._scopeYamlErrors = o;
  }
  _handleYamlValueChanged(e, t) {
    if (t.stopPropagation(), !t.detail.isValid) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [e]: t.detail.errorMsg ?? this._t("editor.yaml.errors.parse_failed")
      };
      return;
    }
    const i = ni(t.detail.value);
    if (!i.ok) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [e]: this._t("editor.yaml.errors.non_json_value")
      };
      return;
    }
    const o = L(e).adapter, a = o.validate(i.value);
    if (a) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [e]: this._formatScopeYamlValidationError(a)
      };
      return;
    }
    try {
      const n = y(i.value);
      this._config = o.apply(this._config ?? {}, n), this._dirty = !0, this._validation = null, this._message = null, this._scopeYamlValues = {
        ...this._scopeYamlValues,
        [e]: n
      };
      const s = { ...this._scopeYamlErrors };
      delete s[e], this._scopeYamlErrors = s;
    } catch (n) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [e]: this._formatError(n, this._t("editor.yaml.errors.apply_failed"))
      };
    }
  }
  _hasBlockingYamlErrors() {
    return Object.values(this._scopeYamlErrors).some(
      (e) => typeof e == "string" && e.length > 0
    );
  }
  _hasBlockingDescendantYamlErrors(e) {
    return Te(e).some(
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
    for (const o of t)
      delete i[o];
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
    const t = A(this._getValue(["device_label_text", e])).map(
      ([o]) => o
    ), i = Ct(t);
    this._applyMutation((o) => {
      m(o, ["device_label_text", e, i], "");
    });
  }
  _handleAddVehicle(e) {
    const t = ["appliances", e, "vehicles"], i = (b(this._getValue(t)) ?? []).map((o) => {
      var a;
      return this._stringValue((a = v(o)) == null ? void 0 : a.id);
    }).filter((o) => o.length > 0);
    this._applyMutation((o) => {
      O(
        o,
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
    ], i = Yt(A(this._getValue(t)).map(([o]) => o));
    this._applyMutation((o) => {
      m(o, [...t, i], Tt());
    });
  }
  _handleAddEcoGear(e) {
    const t = [
      "appliances",
      e,
      "controls",
      "eco_gear",
      "values"
    ], i = Ut(A(this._getValue(t)).map(([o]) => o));
    this._applyMutation((o) => {
      m(o, [...t, i], Ft());
    });
  }
  _handleProjectedApplianceProjectionStrategyChange(e, t) {
    ["fixed", "history_average"].includes(t) && this._applyMutation((i) => {
      const o = ["appliances", e, "projection"];
      if (m(i, [...o, "strategy"], t), t !== "history_average")
        return;
      const a = v(
        k(i, [...o, "history_average"])
      ), n = a == null ? void 0 : a.lookback_days;
      m(i, [...o, "history_average"], {
        energy_entity_id: this._stringValue(a == null ? void 0 : a.energy_entity_id),
        lookback_days: typeof n == "number" && Number.isFinite(n) ? n : 30
      });
    });
  }
  _handleRenameObjectKey(e, t, i) {
    const o = i.trim();
    if (!o || o === t || !this._config)
      return;
    const a = y(this._config), n = Ot(a, e, t, o);
    if (!n.ok) {
      this._message = { kind: "error", text: this._formatRenameObjectKeyError(n) };
      return;
    }
    this._config = a, this._dirty = !0, this._validation = null, this._message = null;
  }
  _moveListItem(e, t, i) {
    this._applyMutation((o) => {
      Pt(o, e, t, i);
    });
  }
  _removeListItem(e, t) {
    this._applyMutation((i) => {
      Mt(i, e, t);
    });
  }
  _removePath(e) {
    this._applyMutation((t) => {
      K(t, e);
    });
  }
  _setOptionalString(e, t) {
    const i = t.trim();
    this._applyMutation((o) => {
      if (!i) {
        K(o, e);
        return;
      }
      m(o, e, i);
    });
  }
  _setRequiredString(e, t) {
    this._applyMutation((i) => {
      m(i, e, t.trim());
    });
  }
  _setOptionalNumber(e, t) {
    const i = t.trim();
    this._applyMutation((o) => {
      if (!i) {
        K(o, e);
        return;
      }
      const a = Number(i);
      m(o, e, Number.isFinite(a) ? a : i);
    });
  }
  _setRequiredNumber(e, t) {
    const i = t.trim();
    this._applyMutation((o) => {
      if (!i) {
        m(o, e, null);
        return;
      }
      const a = Number(i);
      m(o, e, Number.isFinite(a) ? a : i);
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
    for (const [o, a] of Object.entries(t))
      i = i.replaceAll(`{${o}}`, String(a));
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
  _scopeYamlErrors: { state: !0 },
  _helpDialog: { state: !0 }
}, ee.styles = rt`
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

    .field ha-entity-picker,
    .field ha-selector {
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

    .field-label-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .field-label-row label {
      flex: 1;
      min-width: 0;
    }

    .help-btn {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 1px solid var(--secondary-text-color);
      background: transparent;
      color: var(--secondary-text-color);
      cursor: pointer;
      font: inherit;
      font-size: 0.72rem;
      font-weight: 700;
      line-height: 1;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .help-btn:hover {
      border-color: var(--primary-color);
      color: var(--primary-color);
      background: rgba(3, 169, 244, 0.08);
    }

    .help-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .help-dialog {
      background: var(--card-background-color);
      border-radius: 18px;
      padding: 22px 24px;
      max-width: 480px;
      width: 100%;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24);
    }

    .help-dialog-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 14px;
    }

    .help-dialog-header strong {
      font-size: 1.05rem;
      line-height: 1.3;
    }

    .help-dialog-close {
      flex-shrink: 0;
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
      color: var(--primary-text-color);
      width: 28px;
      height: 28px;
      border-radius: 50%;
      cursor: pointer;
      font: inherit;
      font-size: 0.9rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    .help-dialog-close:hover {
      background: rgba(127, 127, 127, 0.08);
    }

    .help-dialog-body {
      color: var(--secondary-text-color);
      line-height: 1.55;
      margin: 0;
      font-size: 0.93rem;
    }
  `;
let pe = ee;
const De = "helman-config-editor-panel";
customElements.get(De) || customElements.define(De, pe);
