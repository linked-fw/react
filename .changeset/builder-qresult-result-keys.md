---
'@_linked/react': patch
---

Fix `linkedComponent` deciding whether `of` is an already-loaded QResult. The check compared the query's property labels against `of`, so a computed-only projection (`{title: Expr.concat(...)}`) had no labels and `of={{id}}` was wrongly treated as loaded (the query never ran), and a renamed key (`{title: p.jobTitle}`) was checked by property label instead of the result key. It now compares the result keys the query produces (custom key when every entry has one, otherwise the property label) and treats an entry with no derivable key as not loaded.
