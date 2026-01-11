import Homey from 'homey';

class SyncoApp extends Homey.App {
  async onInit(): Promise<void> {
    this.log('Siemens Synco Living app started');
  }
}

module.exports = SyncoApp;
