// taskcell.dev Worker: sends www.taskcell.dev to the apex (a _redirects file cannot match on the host),
// and serves everything else from dist/, where _headers sets the security and cache headers.
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'www.taskcell.dev') {
      url.hostname = 'taskcell.dev';
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
