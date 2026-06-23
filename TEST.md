
# freyr testing

freyr is bundled with its own flexibly customizable test runner.

- To run the default local queue-server tests

  ```console
  npm test
  ```

- To run all provider download tests

  ```console
  npm run test:providers -- --all
  ```

- To run just Deezer tests

  ```console
  npm run test:providers -- deezer
  ```

- To run just Deezer artist tests

  ```console
  npm run test:providers -- deezer.artist
  ```

- You can use a custom test suite (see the [default suite](https://github.com/miraclx/freyr-js/blob/master/test/default.json) for an example)

  ```console
  npm run test:providers -- --all --suite ./special_cases.json
  ```

- And optionally, you can run the tests inside a freyr docker container

  ```console
  npm run test:providers -- deezer --docker freyr-dev:latest
  ```

- You can customize the working directory for storing the tracks and logs

  ```console
  npm run test:providers -- deezer.track --name run-1 --stage ./test-runs
  ```

## `npm run test:providers -- --help`

```console
freyr-test
----------
Usage: freyr-test [options] [<SERVICE>[.<TYPE>]...]

Utility for testing the Freyr CLI

Options:

  SERVICE                 deezer
  TYPE                    track / album / artist / playlist

  --all                   run all tests
  --suite <SUITE>         use a specific test suite (json)
  --docker <IMAGE>        run tests in a docker container
  --help                  show this help message

Enviroment Variables:

  DOCKER_ARGS             arguments to pass to `docker run`

Example:

  $ freyr-test --all
      runs all tests

  $ freyr-test deezer
      runs all Deezer tests

  $ freyr-test deezer.album
      tests downloading a Deezer album

  $ freyr-test deezer.track deezer.artist
      tests downloading a Deezer track and Deezer artist
```
